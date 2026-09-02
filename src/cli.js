#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { benchmark } = require("./benchmark");
const { detectCpuInfo } = require("./cpu");
const { buildMatrix, parseBenchmarks, parseThreadSpec, STRATEGIES } = require("./matrix");
const { createReport } = require("./report");

function usage() {
  return `Usage: test_scaling 'COMMAND WITH {threads}' [options]
       test_scaling [options] -- COMMAND ARGUMENTS
       test_scaling --benchmarks FILE [options]

Run ThreadScale without GitHub Actions and create the same report artifacts.
The command must pass {threads} through the program's thread-count argument,
or --thread-env must name the environment variable that controls its threads.

Options:
  --name NAME             benchmark name (default: benchmark)
  --benchmarks FILE       optional JSON benchmark array for multiple commands
  --threads SPEC          auto, powers-of-two, list, or range (default: powers-of-two)
  --max-threads N         cap detected CPUs; zero uses every visible CPU (default: 0)
  --duration SECONDS      minimum measured time per thread count (default: 0)
  --runs N                minimum measured runs per thread count (default: 5)
  --warmup-runs N         warmup runs per thread count (default: 1)
  --strategy VALUE        single-sweep, thread-sharded, or replicated-sweep (--fan-out alias)
  --replicas N            sequential complete sweeps for replicated-sweep (default: 1)
  --thread-env NAME       set an environment variable instead of requiring {threads}
  --timeout-seconds N     timeout for each invocation (default: 300)
  --working-directory DIR command working directory (default: current directory)
  --workload NUMBER       work per invocation; supplies {workload} and enables rate reporting
  --workload-unit UNIT    rate unit such as events or cells (default: items)
  --output-dir DIR        final report directory (default: thread-scaling)
  --summary-plots VALUE   none, time, rate, or both (default: both)
  -h, --help              show this help
`;
}

function integerOption(name, raw, minimum) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}; received ${raw}`);
  }
  return value;
}

function numberOption(name, raw, minimum) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number greater than or equal to ${minimum}; received ${raw}`);
  }
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseArgs(argv) {
  const options = {
    benchmarkFile: "",
    benchmarkName: "benchmark",
    command: "",
    durationSeconds: 0,
    help: false,
    maxThreads: 0,
    outputDirectory: "thread-scaling",
    replicas: 1,
    runs: 5,
    strategy: "single-sweep",
    summaryPlots: "both",
    threadEnvironment: "",
    threads: "powers-of-two",
    timeoutSeconds: 300,
    warmupRuns: 1,
    workingDirectory: ".",
    workload: 0,
    workloadUnit: "items",
  };
  const names = new Map([
    ["--benchmarks", "benchmarkFile"],
    ["--duration", "durationSeconds"],
    ["--duration-seconds", "durationSeconds"],
    ["--fan-out", "strategy"],
    ["--max-threads", "maxThreads"],
    ["--name", "benchmarkName"],
    ["--output-dir", "outputDirectory"],
    ["--replicas", "replicas"],
    ["--runs", "runs"],
    ["--strategy", "strategy"],
    ["--summary-plots", "summaryPlots"],
    ["--thread-env", "threadEnvironment"],
    ["--threads", "threads"],
    ["--timeout-seconds", "timeoutSeconds"],
    ["--warmup-runs", "warmupRuns"],
    ["--working-directory", "workingDirectory"],
    ["--workload", "workload"],
    ["--workload-unit", "workloadUnit"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--") {
      if (options.command) {
        throw new Error("only one benchmark command may be provided");
      }
      options.command = argv.slice(index + 1).map(shellQuote).join(" ");
      break;
    }
    const key = names.get(argument);
    if (!key) {
      if (!argument.startsWith("-") && !options.command) {
        options.command = argument;
        continue;
      }
      throw new Error(`unknown option: ${argument}`);
    }
    index += 1;
    if (index >= argv.length) {
      throw new Error(`${argument} requires a value`);
    }
    options[key] = argv[index];
  }
  options.durationSeconds = numberOption("--duration", options.durationSeconds, 0);
  options.maxThreads = integerOption("--max-threads", options.maxThreads, 0);
  options.replicas = integerOption("--replicas", options.replicas, 1);
  options.runs = integerOption("--runs", options.runs, 1);
  options.timeoutSeconds = integerOption("--timeout-seconds", options.timeoutSeconds, 0);
  options.warmupRuns = integerOption("--warmup-runs", options.warmupRuns, 0);
  options.workload = numberOption("--workload", options.workload, 0);
  if (!STRATEGIES.has(options.strategy)) {
    throw new Error(`--strategy must be one of ${[...STRATEGIES].join(", ")}`);
  }
  if (options.strategy !== "replicated-sweep" && options.replicas !== 1) {
    throw new Error("--replicas requires --strategy replicated-sweep");
  }
  if (!options.help && !options.benchmarkFile && !options.command) {
    throw new Error("provide a benchmark command or --benchmarks FILE");
  }
  if (options.benchmarkFile && options.command) {
    throw new Error("use either a benchmark command or --benchmarks FILE, not both");
  }
  return options;
}

function cpuSummary(cpu, threadSpec, strategy, replicas) {
  const topology = [];
  if (cpu.physical_cores) topology.push(`${cpu.physical_cores} physical cores`);
  if (cpu.threads_per_core) topology.push(`${cpu.threads_per_core} threads/core`);
  if (cpu.sockets) topology.push(`${cpu.sockets} socket${cpu.sockets === 1 ? "" : "s"}`);
  return [
    `CPUs available: ${cpu.visible_cpus}`,
    `CPU: ${cpu.cpu_model || "unknown"}`,
    topology.length > 0 ? `Topology: ${topology.join(", ")}` : "",
    cpu.affinity ? `Affinity: ${cpu.affinity}` : "",
    `Thread counts: ${threadSpec.join(", ")}`,
    `Strategy: ${strategy}`,
    `Replicas: ${replicas}`,
  ].filter(Boolean).join("\n");
}

async function runLocal(options) {
  const outputDirectory = path.resolve(options.outputDirectory);
  const partialDirectory = `${outputDirectory}.parts`;
  if (fs.existsSync(outputDirectory) || fs.existsSync(partialDirectory)) {
    throw new Error(`output already exists: ${outputDirectory} or ${partialDirectory}`);
  }
  const definitions = options.benchmarkFile
    ? parseBenchmarks(fs.readFileSync(path.resolve(options.benchmarkFile), "utf8"))
    : [{
      command: options.command,
      name: options.benchmarkName,
      working_directory: options.workingDirectory,
      workload: options.workload,
      workload_unit: options.workloadUnit,
    }];
  const cpu = detectCpuInfo(options.maxThreads);
  const threads = parseThreadSpec(options.threads, cpu.visible_cpus);
  const matrix = buildMatrix({
    benchmarks: definitions,
    replicas: options.replicas,
    strategy: options.strategy,
    threads,
  });
  console.log(`\n${cpuSummary(cpu, threads, options.strategy, options.replicas)}\n`);

  for (const entry of matrix.include) {
    console.log(`\n=== ${entry.benchmark}, replica ${entry.replica} ===`);
    await benchmark({
      benchmarkName: entry.benchmark,
      command: entry.command,
      minimumDurationSeconds: options.durationSeconds,
      outputDirectory: partialDirectory,
      replica: entry.replica,
      runnerInfo: cpu,
      runs: options.runs,
      threadEnvironment: options.threadEnvironment,
      threads: parseThreadSpec(entry.threads, cpu.visible_cpus),
      timeoutSeconds: options.timeoutSeconds,
      warmupRuns: options.warmupRuns,
      workload: entry.workload,
      workloadUnit: entry.workload_unit,
      workingDirectory: path.resolve(entry.working_directory),
    });
  }

  const result = createReport({
    inputDirectory: partialDirectory,
    minimumEfficiency: 0,
    outputDirectory,
    summaryPlots: options.summaryPlots,
  });
  const summary = fs.readFileSync(result.summaryFile, "utf8");
  console.log(`\n${summary}`);
  console.log(`Report: ${outputDirectory}`);
  console.log(`Partial measurements: ${partialDirectory}`);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await runLocal(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runLocal, usage };
