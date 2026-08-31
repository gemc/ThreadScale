const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { expandCommand } = require("../src/benchmark");
const { parseLscpu } = require("../src/cpu");
const { buildMatrix, parseBenchmarks, parseThreadSpec } = require("../src/matrix");
const {
  aggregate,
  buildMarkdown,
  createReport,
  median,
  renderChart,
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
  assert.throws(() => parseBenchmarks("[]"), /non-empty/);
  assert.equal(
    expandCommand("run -t {threads} -r {run} -p {replica} -b {benchmark}", {
      benchmark: "demo",
      replica: 2,
      run: 3,
      threads: 4,
    }),
    "run -t 4 -r 3 -p 2 -b demo",
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
  assert.equal(benchmarks[0].points[1].speedup, 2);
  assert.equal(benchmarks[0].points[1].efficiency_percent, 100);
  assert.equal(benchmarks[0].points[1].median_rate, 20);
  assert.equal(benchmarks[0].replicas[0].points[1].speedup, 2);
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
        { median: 2, median_rate: 10, speedup: 1, threads: 1 },
        { median: 1.2, median_rate: 16.7, speedup: 1.67, threads: 2 },
      ],
      replica: 1,
      runner: { physical_cores: 1, threads_per_core: 2, visible_cpus: 2 },
    }],
    runners: [{ physical_cores: 1, threads_per_core: 2, visible_cpus: 2 }],
    points: [
      {
        count: 1,
        efficiency_percent: 100,
        median: 2,
        median_rate: 10,
        speedup: 1,
        standard_deviation: 0,
        threads: 1,
      },
      {
        count: 1,
        efficiency_percent: 83.3,
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
  assert.match(rateChart, /plotColorPalette: "#0969da"/);
  assert.match(rateChart, /text:first-child \{ text-anchor: start; \}/);
  assert.match(rateChart, /text:last-child \{ text-anchor: end; \}/);
  assert.doesNotMatch(timeChart, /Measured points/);
  assert.doesNotMatch(buildMarkdown([benchmark], "none"), /xychart/);
  assert.match(buildMarkdown([benchmark], "time"), /### Time vs threads/);
  assert.doesNotMatch(buildMarkdown([benchmark], "time"), /### Rate vs threads/);
  assert.match(buildMarkdown([benchmark], "rate"), /### Rate vs threads/);
  assert.doesNotMatch(buildMarkdown([benchmark], "rate"), /### Time vs threads/);
  assert.match(buildMarkdown([benchmark], "both"), /### Time vs threads[\s\S]*### Rate vs threads/);
  assert.match(buildMarkdown([benchmark], "both"), /Std\. dev\./);
  assert.match(buildMarkdown([benchmark], "both"), /Per-replica sweeps \(1\)/);
  assert.match(buildMarkdown([benchmark], "both"), /1 OS physical cores, 2 threads\/core/);
  assert.throws(() => buildMarkdown([benchmark], "invalid"), /summary-plots/);
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
  assert.match(summary, /Runner configurations/);
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
