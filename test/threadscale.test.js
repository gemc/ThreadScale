const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { expandCommand } = require("../src/benchmark");
const { parseArgs, runLocal } = require("../src/cli");
const { parseLscpu } = require("../src/cpu");
const { buildMatrix, parseBenchmarks, parseThreadSpec } = require("../src/matrix");
const {
  aggregate,
  buildMarkdown,
  createReport,
  effectiveSerialFraction,
  median,
  renderChart,
  renderMermaidComparisonChart,
  renderMermaidRateChart,
  renderMermaidTimeChart,
  statistics,
} = require("../src/report");

const BENCHMARKS = [{
  name: "demo",
  command: "demo --threads {threads}",
  working_directory: ".",
  workload: 100,
  workload_unit: "events",
}];

test("auto and power-of-two thread specifications respect the visible CPU count", () => {
  assert.deepEqual(parseThreadSpec("auto", 4), [1, 2, 3, 4]);
  assert.deepEqual(parseThreadSpec("powers-of-two", 6), [1, 2, 4, 6]);
  assert.deepEqual(parseThreadSpec("1, 3-5, 3", 8), [1, 3, 4, 5]);
  assert.deepEqual(parseThreadSpec("2,3,4,1", 4), [2, 3, 4, 1]);
  assert.throws(() => parseThreadSpec("1,9", 8), /exceeds/);
  assert.throws(() => parseThreadSpec("9,1", 8), /exceeds/);
});

test("local CLI options are validated", () => {
  const options = parseArgs([
    "--threads", "powers-of-two",
    "--max-threads", "64",
    "--strategy", "replicated-sweep",
    "--replicas", "2",
    "gemc -nthreads={threads}",
  ]);
  assert.equal(options.command, "gemc -nthreads={threads}");
  assert.equal(options.threads, "powers-of-two");
  assert.equal(options.maxThreads, 64);
  assert.equal(options.replicas, 2);
  assert.throws(() => parseArgs([]), /provide a benchmark command/);
  assert.throws(
    () => parseArgs(["gemc {threads}", "--replicas", "2"]),
    /requires --strategy replicated-sweep/,
  );
  assert.match(parseArgs(["--", "gemc", "-nthreads={threads}"]).command, /gemc.*nthreads/);
  assert.equal(parseArgs(["gemc {threads}", "--fan-out", "thread-sharded"]).strategy, "thread-sharded");
});

test("all three matrix strategies have stable shapes", () => {
  const single = buildMatrix({
    benchmarks: BENCHMARKS,
    threads: [1, 2],
    strategy: "single-sweep",
    replicas: 2,
  });
  const sharded = buildMatrix({
    benchmarks: BENCHMARKS,
    threads: [1, 2],
    strategy: "thread-sharded",
    replicas: 2,
  });
  const replicated = buildMatrix({
    benchmarks: BENCHMARKS,
    threads: [1, 2],
    strategy: "replicated-sweep",
    replicas: 2,
  });
  assert.equal(single.include.length, 1);
  assert.equal(single.include[0].threads, "1,2");
  assert.deepEqual(sharded.include.map((item) => item.threads), ["1", "2"]);
  assert.deepEqual(replicated.include.map((item) => item.replica), [1, 2]);
  assert.deepEqual(replicated.include.map((item) => item.threads), ["1,2", "2,1"]);
  assert.deepEqual(
    replicated.include.map((item) => parseThreadSpec(item.threads, 2)),
    [[1, 2], [2, 1]],
  );
});

test("Linux CPU topology is parsed for prominent runner reporting", () => {
  assert.deepEqual(parseLscpu(`
CPU(s):                   4
Thread(s) per core:       2
Core(s) per socket:       2
Socket(s):                1
NUMA node(s):             1
`), {
    cores_per_socket: 2,
    numa_nodes: 1,
    physical_cores: 2,
    sockets: 1,
    threads_per_core: 2,
  });
});

test("benchmark JSON and command placeholders are validated and expanded", () => {
  assert.deepEqual(parseBenchmarks(JSON.stringify(BENCHMARKS)), BENCHMARKS);
  const compared = parseBenchmarks(JSON.stringify([{
    ...BENCHMARKS[0],
    comparison_group: "output comparison",
    comparison_label: "no output",
  }]));
  assert.equal(compared[0].comparison_group, "output comparison");
  assert.equal(compared[0].comparison_label, "no output");
  assert.throws(() => parseBenchmarks("[]"), /non-empty/);
  assert.equal(
    expandCommand("run -t {threads} -n {workload} -r {run} -p {replica} -b {benchmark}", {
      benchmark: "demo",
      replica: 2,
      run: 3,
      threads: 4,
      workload: 100,
    }),
    "run -t 4 -n 100 -r 3 -p 2 -b demo",
  );
});

test("statistics and scaling aggregation use the median one-thread baseline", () => {
  assert.equal(median([3, 1, 2, 4]), 2.5);
  assert.equal(statistics([1, 2, 3]).mean, 2);
  const benchmarks = aggregate([
    {
      benchmark: "demo",
      command: "demo {threads}",
      measurements: [
        { run: 1, seconds: 10, threads: 1 },
        { run: 2, seconds: 12, threads: 1 },
        { run: 1, seconds: 6, threads: 2 },
        { run: 2, seconds: 5, threads: 2 },
      ],
      runner: { visible_cpus: 2 },
      workload: 110,
      workload_unit: "events",
    },
  ]);
  assert.equal(benchmarks[0].points[0].median, 11);
  assert.equal(benchmarks[0].points[0].effective_serial_fraction, null);
  assert.equal(benchmarks[0].points[1].speedup, 2);
  assert.equal(benchmarks[0].points[1].effective_serial_fraction, 0);
  assert.equal(benchmarks[0].points[1].efficiency_percent, 100);
  assert.equal(benchmarks[0].points[1].median_rate, 20);
  assert.equal(benchmarks[0].replicas[0].points[1].speedup, 2);
});

test("effective serial fraction follows the Amdahl and Karp-Flatt estimate", () => {
  assert.equal(effectiveSerialFraction(1, 1), null);
  const measured = effectiveSerialFraction(31.3 / 7.551, 8);
  assert.ok(Math.abs(measured - 0.132852578) < 1e-9);
});

test("replicated sweeps use median paired speedups", () => {
  const partial = (replica, baseline, parallel) => ({
    benchmark: "paired",
    command: "demo {threads}",
    measurements: [
      { run: 1, seconds: baseline, threads: 1 },
      { run: 1, seconds: parallel, threads: 2 },
    ],
    replica,
    runner: { visible_cpus: 2 },
    workload: 0,
  });
  const benchmarks = aggregate([
    partial(1, 10, 8),
    partial(2, 100, 50),
  ]);
  assert.equal(benchmarks[0].points[1].speedup, 1.625);
  assert.equal(benchmarks[0].points[1].paired_speedup_samples, 2);
});

test("the Markdown summary supports time and rate plots", () => {
  const benchmark = {
    name: "demo",
    workload: 20,
    workload_unit: "events",
    replicas: [{
      points: [
        { effective_serial_fraction: null, median: 2, median_rate: 10, speedup: 1, threads: 1 },
        { effective_serial_fraction: 0.1976, median: 1.2, median_rate: 16.7, speedup: 1.67, threads: 2 },
      ],
      replica: 1,
      runner: { physical_cores: 1, threads_per_core: 2, visible_cpus: 2 },
    }],
    runners: [{ physical_cores: 1, threads_per_core: 2, visible_cpus: 2 }],
    points: [
      {
        count: 1,
        efficiency_percent: 100,
        effective_serial_fraction: null,
        median: 2,
        median_rate: 10,
        speedup: 1,
        standard_deviation: 0,
        threads: 1,
      },
      {
        count: 1,
        efficiency_percent: 83.3,
        effective_serial_fraction: 0.1976,
        median: 1.2,
        median_rate: 16.7,
        speedup: 1.67,
        standard_deviation: 0,
        threads: 2,
      },
    ],
  };
  const timeChart = renderMermaidTimeChart(benchmark);
  const rateChart = renderMermaidRateChart(benchmark);
  assert.match(timeChart, /x-axis "Threads" \[1, 2\]/);
  assert.match(timeChart, /line \[2 "● 2\.00", 1\.2 "● 1\.20"\]/);
  assert.match(rateChart, /line \[10 "● 10\.0", 16\.7 "● 16\.7"\]/);
  assert.match(rateChart, /plotColorPalette: "#0969da, #cf6a00/);
  assert.doesNotMatch(timeChart, /Measured points/);
  assert.doesNotMatch(rateChart, /Measured points/);
  assert.doesNotMatch(buildMarkdown([benchmark], "none"), /xychart/);
  assert.match(buildMarkdown([benchmark], "time"), /### Time vs threads/);
  assert.doesNotMatch(buildMarkdown([benchmark], "time"), /### Rate vs threads/);
  assert.match(buildMarkdown([benchmark], "rate"), /### Rate vs threads/);
  assert.doesNotMatch(buildMarkdown([benchmark], "rate"), /### Time vs threads/);
  assert.match(buildMarkdown([benchmark], "both"), /### Time vs threads[\s\S]*### Rate vs threads/);
  assert.match(buildMarkdown([benchmark], "both"), /Std\. dev\./);
  assert.match(buildMarkdown([benchmark], "both"), /Effective serial/);
  assert.match(buildMarkdown([benchmark], "both"), /Lower is better/);
  assert.match(buildMarkdown([benchmark], "both"), /19\.8%/);
  assert.match(buildMarkdown([benchmark], "both"), /Per-replica sweeps \(1\)/);
  assert.match(buildMarkdown([benchmark], "both"), /1 OS physical cores, 2 threads\/core/);
  assert.throws(() => buildMarkdown([benchmark], "invalid"), /summary-plots/);

  const comparisons = [
    {
      ...benchmark,
      comparison_group: "Output comparison",
      comparison_label: "No output",
      name: "no-output",
    },
    {
      ...benchmark,
      comparison_group: "Output comparison",
      comparison_label: "ROOT output",
      name: "root-output",
      points: benchmark.points.map((point) => ({
        ...point,
        median_rate: point.median_rate * 0.9,
      })),
    },
  ];
  const comparisonChart = renderMermaidComparisonChart(comparisons, "rate");
  assert.match(comparisonChart, /Series:\*\* 🔵 No output · 🟠 ROOT output/);
  assert.match(comparisonChart, /line \[10 "● 10\.0"/);
  assert.match(comparisonChart, /line \[9 "● 9\.00"/);
  const comparisonMarkdown = buildMarkdown(comparisons, "rate");
  assert.equal((comparisonMarkdown.match(/\`\`\`mermaid/g) || []).length, 1);
  assert.match(comparisonMarkdown, /## Output comparison/);
});

test("SVG charts emphasize and label measured points", () => {
  const chart = renderChart({
    points: [{ x: 1, y: 2 }, { x: 2, y: 1.2 }],
    title: "demo",
    yLabel: "Median time (seconds)",
  });
  assert.equal((chart.match(/<circle class="point"/g) || []).length, 2);
  assert.match(chart, /<text class="point-label"[^>]*>2\.00<\/text>/);
  assert.match(chart, /<text class="point-label"[^>]*>1\.20<\/text>/);
});

test("report mode writes portable artifacts and plots", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "threadscale-test-"));
  const input = path.join(temporary, "parts");
  const output = path.join(temporary, "report");
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, "partial.json"), JSON.stringify({
    schema_version: 1,
    kind: "thread-scale-partial",
    benchmark: "demo",
    command: "demo {threads}",
    measurements: [
      { run: 1, seconds: 2, threads: 1 },
      { run: 1, seconds: 1.2, threads: 2 },
    ],
    replica: 1,
    runner: { physical_cores: 1, threads_per_core: 2, visible_cpus: 2 },
    workload: 20,
    workload_unit: "events",
  }));
  fs.writeFileSync(path.join(input, "partial-2.json"), JSON.stringify({
    schema_version: 1,
    kind: "thread-scale-partial",
    benchmark: "demo",
    command: "demo {threads}",
    measurements: [
      { run: 1, seconds: 3, threads: 1 },
      { run: 1, seconds: 2, threads: 2 },
    ],
    replica: 2,
    runner: { physical_cores: 2, threads_per_core: 1, visible_cpus: 2 },
    workload: 20,
    workload_unit: "events",
  }));
  const result = createReport({ inputDirectory: input, minimumEfficiency: 0, outputDirectory: output });
  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.report.benchmarks[0].replicas.map((replica) => replica.replica), [1, 2]);
  const summary = fs.readFileSync(result.summaryFile, "utf8");
  const csv = fs.readFileSync(result.csvFile, "utf8");
  assert.match(summary, /Runner configurations/);
  assert.match(summary, /Effective serial fraction/);
  assert.match(csv, /effective_serial_fraction/);
  assert.match(summary, /### Time vs threads/);
  assert.match(summary, /### Rate vs threads/);
  for (const filename of [
    "scaling.csv",
    "scaling.json",
    "summary.md",
    "demo/time-vs-threads.svg",
    "demo/speedup-vs-threads.svg",
    "demo/efficiency-vs-threads.svg",
    "demo/rate-vs-threads.svg",
    "demo/replicas/replica-1/time-vs-threads.svg",
    "demo/replicas/replica-1/speedup-vs-threads.svg",
    "demo/replicas/replica-1/rate-vs-threads.svg",
    "demo/replicas/replica-2/time-vs-threads.svg",
    "demo/replicas/replica-2/speedup-vs-threads.svg",
    "demo/replicas/replica-2/rate-vs-threads.svg",
  ]) {
    assert.equal(fs.existsSync(path.join(output, filename)), true, filename);
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

test("local CLI runs a benchmark and writes the standard report", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "threadscale-local-test-"));
  const output = path.join(temporary, "report");
  const checkWorkload = "if (!process.argv.includes('10')) process.exit(2); setTimeout(() => {}, 5)";
  try {
    const options = parseArgs([
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(checkWorkload)} -- {threads} {workload}`,
      "--name", "local-demo",
      "--threads", "1",
      "--max-threads", "1",
      "--duration", "0.1",
      "--runs", "1",
      "--warmup-runs", "0",
      "--timeout-seconds", "30",
      "--working-directory", temporary,
      "--workload", "10",
      "--output-dir", output,
      "--summary-plots", "none",
    ]);
    const result = await runLocal(options);
    assert.equal(fs.existsSync(result.summaryFile), true);
    assert.equal(fs.existsSync(path.join(output, "scaling.json")), true);
    assert.match(fs.readFileSync(result.summaryFile, "utf8"), /local-demo/);
    assert.equal(result.report.benchmarks[0].points[0].count >= 2, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("local CLI renders grouped benchmark definitions as one comparison chart", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "threadscale-comparison-test-"));
  const benchmarkFile = path.join(temporary, "benchmarks.json");
  const output = path.join(temporary, "report");
  const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5)" -- {threads}`;
  fs.writeFileSync(benchmarkFile, JSON.stringify([
    {
      command,
      comparison_group: "output comparison",
      comparison_label: "No output",
      name: "no-output",
      workload: 10,
      workload_unit: "events",
    },
    {
      command,
      comparison_group: "output comparison",
      comparison_label: "ROOT output",
      name: "root-output",
      workload: 10,
      workload_unit: "events",
    },
  ]));
  try {
    await runLocal(parseArgs([
      "--benchmarks", benchmarkFile,
      "--threads", "1",
      "--runs", "1",
      "--warmup-runs", "0",
      "--summary-plots", "rate",
      "--output-dir", output,
    ]));
    const summary = fs.readFileSync(path.join(output, "summary.md"), "utf8");
    assert.equal((summary.match(/```mermaid/g) || []).length, 1);
    assert.match(summary, /Series:\*\* 🔵 No output · 🟠 ROOT output/);
    assert.equal((summary.match(/    line \[/g) || []).length, 2);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("local thread-sharded strategy retains every partial result", async (context) => {
  if (typeof os.availableParallelism === "function" && os.availableParallelism() < 2) {
    context.skip("requires two visible CPUs");
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "threadscale-sharded-test-"));
  const output = path.join(temporary, "report");
  try {
    const options = parseArgs([
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5)" -- {threads}`,
      "--threads", "1,2",
      "--max-threads", "2",
      "--strategy", "thread-sharded",
      "--runs", "1",
      "--warmup-runs", "0",
      "--output-dir", output,
      "--summary-plots", "none",
    ]);
    const result = await runLocal(options);
    assert.deepEqual(result.report.benchmarks[0].points.map((point) => point.threads), [1, 2]);
    assert.equal(fs.readdirSync(`${output}.parts`).filter((name) => name.endsWith(".json")).length, 2);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
