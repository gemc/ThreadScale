const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { detectCpuInfo } = require("./cpu");
const { ensureDirectory, slugify } = require("./utils");

function expandCommand(template, values) {
  return template.replace(/\{(threads|workload|run|replica|benchmark)\}/g, (_, key) => String(values[key]));
}

function runCommand(command, { cwd, env, timeoutSeconds }) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/bash";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-eo", "pipefail", "-c", command];
    const child = spawn(shell, args, { cwd, env, stdio: "inherit" });
    let timedOut = false;
    const timeout = timeoutSeconds > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutSeconds * 1000)
      : null;

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      if (timedOut) {
        reject(new Error(`command timed out after ${timeoutSeconds} seconds`));
      } else if (code !== 0) {
        reject(new Error(`command exited with code ${code}${signal ? ` (${signal})` : ""}`));
      } else {
        resolve(seconds);
      }
    });
  });
}

async function benchmark(options) {
  const {
    benchmarkName,
    command,
    comparisonGroup = "",
    comparisonLabel = benchmarkName,
    outputDirectory,
    minimumDurationSeconds = 0,
    replica,
    runnerInfo = detectCpuInfo(),
    runs,
    threadEnvironment,
    threads,
    timeoutSeconds,
    warmupRuns,
    workload,
    workloadUnit,
    workingDirectory,
  } = options;
  if (!command.includes("{threads}") && !threadEnvironment) {
    throw new Error("command must contain {threads}, or thread-env must name an environment variable");
  }

  const measurements = [];
  for (const thread of threads) {
    for (let warmupRun = 1; warmupRun <= warmupRuns; warmupRun += 1) {
      const expanded = expandCommand(command, {
        benchmark: benchmarkName,
        replica,
        run: 0,
        threads: thread,
        workload,
      });
      const environment = { ...process.env };
      if (threadEnvironment) {
        environment[threadEnvironment] = String(thread);
      }
      console.log(`\n[${benchmarkName}] threads=${thread} warmup=${warmupRun}`);
      console.log(`$ ${expanded}`);
      const seconds = await runCommand(expanded, {
        cwd: workingDirectory,
        env: environment,
        timeoutSeconds,
      });
      console.log(`completed in ${seconds.toFixed(6)} s`);
    }
    let measuredDuration = 0;
    let measuredRun = 1;
    while (measuredRun <= runs || measuredDuration < minimumDurationSeconds) {
      const expanded = expandCommand(command, {
        benchmark: benchmarkName,
        replica,
        run: measuredRun,
        threads: thread,
        workload,
      });
      const environment = { ...process.env };
      if (threadEnvironment) {
        environment[threadEnvironment] = String(thread);
      }
      console.log(`\n[${benchmarkName}] threads=${thread} run=${measuredRun}`);
      console.log(`$ ${expanded}`);
      const seconds = await runCommand(expanded, {
        cwd: workingDirectory,
        env: environment,
        timeoutSeconds,
      });
      console.log(`completed in ${seconds.toFixed(6)} s`);
      measurements.push({ run: measuredRun, seconds, threads: thread });
      measuredDuration += seconds;
      measuredRun += 1;
    }
  }

  const result = {
    schema_version: 1,
    kind: "thread-scale-partial",
    benchmark: benchmarkName,
    command,
    comparison_group: comparisonGroup,
    comparison_label: comparisonLabel,
    created_at: new Date().toISOString(),
    measurements,
    replica,
    runner: runnerInfo,
    workload,
    workload_unit: workloadUnit,
  };
  ensureDirectory(outputDirectory);
  const threadLabel = [...new Set(measurements.map((measurement) => measurement.threads))].join("-");
  const filename = path.join(
    outputDirectory,
    `${slugify(benchmarkName)}-r${replica}-t${threadLabel}-${process.pid}.json`,
  );
  fs.writeFileSync(filename, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { filename, result };
}

module.exports = { benchmark, expandCommand, runCommand };
