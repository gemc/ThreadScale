#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { benchmark } = require("./benchmark");
const { detectCpuInfo } = require("./cpu");
const { buildMatrix, parseBenchmarks, parseThreadSpec } = require("./matrix");
const { createReport } = require("./report");
const {
  appendSummary,
  getInput,
  getIntegerInput,
  getNumberInput,
  setOutput,
} = require("./utils");

function cpuSummary(cpu) {
  const lines = [
    "## ThreadScale CPU discovery",
    "",
    `- CPUs available to this job: ${cpu.visible_cpus}`,
    `- Logical CPUs reported by the OS: ${cpu.logical_cpus}`,
    `- CPU: ${cpu.cpu_model || "unknown"}`,
    `- OS: ${cpu.platform} ${cpu.release} (${cpu.architecture})`,
  ];
  if (cpu.affinity) {
    lines.push(`- Affinity: ${cpu.affinity}`);
  }
  lines.push("");
  return lines.join("\n");
}

function discover() {
  const maxThreads = getIntegerInput("max-threads", 0);
  const cpu = detectCpuInfo(maxThreads);
  const threads = parseThreadSpec(getInput("threads", "auto"), cpu.visible_cpus);
  const strategy = getInput("strategy", "single-sweep");
  const replicaInput = getInput("replicas", "auto").toLowerCase();
  const replicas = replicaInput === "auto" ? threads.length : Number(replicaInput);
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new Error(`replicas must be auto or a positive integer; received ${replicaInput}`);
  }
  const benchmarks = parseBenchmarks(getInput("benchmarks"));
  const matrix = buildMatrix({ benchmarks, replicas, strategy, threads });
  setOutput("cores", cpu.visible_cpus);
  setOutput("thread-list", threads);
  setOutput("matrix", matrix);
  setOutput("job-count", matrix.include.length);
  setOutput("runner-metadata", cpu);
  appendSummary(`${cpuSummary(cpu)}\nStrategy: \`${strategy}\`; generated ${matrix.include.length} jobs.\n`);
}

async function runBenchmark() {
  const maxThreads = getIntegerInput("max-threads", 0);
  const cpu = detectCpuInfo(maxThreads);
  const threads = parseThreadSpec(getInput("threads", "auto"), cpu.visible_cpus);
  const result = await benchmark({
    benchmarkName: getInput("benchmark-name", "benchmark"),
    command: getInput("command"),
    outputDirectory: getInput("output-dir", "thread-scaling"),
    replica: getIntegerInput("replica", 1, 1),
    runs: getIntegerInput("runs", 5, 1),
    threadEnvironment: getInput("thread-env"),
    threads,
    timeoutSeconds: getIntegerInput("timeout-seconds", 300),
    warmupRuns: getIntegerInput("warmup-runs", 1),
    workload: getNumberInput("workload", 0),
    workloadUnit: getInput("workload-unit", "items"),
    workingDirectory: path.resolve(getInput("working-directory", process.cwd())),
  });
  setOutput("result-file", result.filename);
  setOutput("results-dir", path.resolve(getInput("output-dir", "thread-scaling")));
  const rows = ["| Threads | Run | Time |", "|---:|---:|---:|"];
  for (const measurement of result.result.measurements) {
    rows.push(`| ${measurement.threads} | ${measurement.run} | ${measurement.seconds.toFixed(3)} s |`);
  }
  appendSummary(`## ThreadScale: ${result.result.benchmark}\n\n${rows.join("\n")}\n`);
}

function report() {
  const outputDirectory = getInput("output-dir", "thread-scaling");
  const result = createReport({
    inputDirectory: getInput("input-dir", "thread-scaling-parts"),
    minimumEfficiency: getNumberInput("minimum-efficiency", 0),
    outputDirectory,
    summaryPlots: getInput("summary-plots", "both"),
  });
  setOutput("results-dir", path.resolve(outputDirectory));
  setOutput("summary-file", path.resolve(result.summaryFile));
  setOutput("csv-file", path.resolve(result.csvFile));
  setOutput("json-file", path.resolve(result.jsonFile));
  appendSummary(fs.readFileSync(result.summaryFile, "utf8"));
  if (result.failures.length > 0) {
    throw new Error(`minimum efficiency was not met:\n${result.failures.join("\n")}`);
  }
}

async function main() {
  const mode = getInput("mode", "benchmark").toLowerCase();
  if (mode === "discover") {
    discover();
  } else if (mode === "benchmark") {
    await runBenchmark();
  } else if (mode === "report") {
    report();
  } else {
    throw new Error(`mode must be discover, benchmark, or report; received ${mode}`);
  }
}

main().catch((error) => {
  console.error(`::error::${error.stack || error.message}`);
  process.exitCode = 1;
});
