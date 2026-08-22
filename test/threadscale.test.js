const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { expandCommand } = require("../src/benchmark");
const { buildMatrix, parseBenchmarks, parseThreadSpec } = require("../src/matrix");
const { aggregate, createReport, median, renderMermaidTimeChart, statistics } = require("../src/report");

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
  assert.throws(() => parseThreadSpec("1,9", 8), /exceeds/);
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

test("the Markdown summary includes a time-vs-threads plot", () => {
  const chart = renderMermaidTimeChart({
    name: "demo",
    points: [
      { median: 2, threads: 1 },
      { median: 1.2, threads: 2 },
    ],
  });
  assert.match(chart, /xychart-beta/);
  assert.match(chart, /x-axis "Threads" \[1, 2\]/);
  assert.match(chart, /line \[2, 1.2\]/);
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
    runner: { visible_cpus: 2 },
    workload: 20,
    workload_unit: "events",
  }));
  const result = createReport({ inputDirectory: input, minimumEfficiency: 0, outputDirectory: output });
  assert.equal(result.failures.length, 0);
  const summary = fs.readFileSync(result.summaryFile, "utf8");
  assert.match(summary, /Runner configurations/);
  assert.match(summary, /### Time vs threads/);
  for (const filename of [
    "scaling.csv",
    "scaling.json",
    "summary.md",
    "demo/time-vs-threads.svg",
    "demo/speedup-vs-threads.svg",
    "demo/efficiency-vs-threads.svg",
    "demo/rate-vs-threads.svg",
  ]) {
    assert.equal(fs.existsSync(path.join(output, filename)), true, filename);
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});
