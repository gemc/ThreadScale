const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function commandOutput(command, args = []) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

function cgroupCpuLimit() {
  try {
    const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota !== "max") {
      return Math.max(1, Math.ceil(Number(quota) / Number(period)));
    }
  } catch {
    // cgroup v2 is not available.
  }

  try {
    const quota = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "utf8").trim());
    const period = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8").trim());
    if (quota > 0 && period > 0) {
      return Math.max(1, Math.ceil(quota / period));
    }
  } catch {
    // cgroup v1 is not available.
  }
  return undefined;
}

function detectCpuInfo(maxThreads = 0) {
  const candidates = [];
  if (typeof os.availableParallelism === "function") {
    candidates.push(positiveInteger(os.availableParallelism()));
  }
  candidates.push(positiveInteger(commandOutput("nproc")));
  candidates.push(cgroupCpuLimit());

  const limits = candidates.filter(Boolean);
  let visibleCpus = limits.length > 0 ? Math.min(...limits) : Math.max(1, os.cpus().length);
  if (maxThreads > 0) {
    visibleCpus = Math.min(visibleCpus, maxThreads);
  }

  return {
    visible_cpus: visibleCpus,
    logical_cpus: os.cpus().length,
    cgroup_cpu_limit: cgroupCpuLimit() || null,
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    runner_name: process.env.RUNNER_NAME || "",
    runner_os: process.env.RUNNER_OS || "",
    runner_arch: process.env.RUNNER_ARCH || "",
    cpu_model: os.cpus()[0]?.model || "",
    affinity: commandOutput("taskset", ["-pc", String(process.pid)]),
    lscpu: commandOutput("lscpu"),
  };
}

module.exports = { cgroupCpuLimit, detectCpuInfo };
