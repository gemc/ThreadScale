const { slugify } = require("./utils");

const STRATEGIES = new Set(["single-sweep", "thread-sharded", "replicated-sweep"]);

function uniqueInOrder(values) {
  return [...new Set(values)];
}

function parseThreadSpec(specification, visibleCpus) {
  const spec = String(specification || "auto").trim().toLowerCase();
  if (spec === "auto" || spec === "all") {
    return Array.from({ length: visibleCpus }, (_, index) => index + 1);
  }
  if (spec === "powers-of-two" || spec === "powers_of_two") {
    const threads = [];
    for (let value = 1; value <= visibleCpus; value *= 2) {
      threads.push(value);
    }
    if (threads.at(-1) !== visibleCpus) {
      threads.push(visibleCpus);
    }
    return threads;
  }

  const threads = [];
  for (const token of spec.split(",")) {
    const range = token.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < start) {
        throw new Error(`invalid thread range: ${token}`);
      }
      for (let value = start; value <= end; value += 1) {
        threads.push(value);
      }
      continue;
    }
    const value = Number(token.trim());
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`invalid thread count: ${token}`);
    }
    threads.push(value);
  }
  const parsed = uniqueInOrder(threads);
  if (parsed.length === 0) {
    throw new Error("at least one thread count is required");
  }
  const maximum = Math.max(...parsed);
  if (maximum > visibleCpus) {
    throw new Error(`thread count ${maximum} exceeds the ${visibleCpus} CPUs visible to the job`);
  }
  return parsed;
}

function parseBenchmarks(json) {
  let benchmarks;
  try {
    benchmarks = JSON.parse(json);
  } catch (error) {
    throw new Error(`benchmarks must be valid JSON: ${error.message}`);
  }
  if (!Array.isArray(benchmarks) || benchmarks.length === 0) {
    throw new Error("benchmarks must be a non-empty JSON array");
  }
  return benchmarks.map((benchmark, index) => {
    if (!benchmark || typeof benchmark !== "object") {
      throw new Error(`benchmark ${index + 1} must be an object`);
    }
    if (!benchmark.name || !benchmark.command) {
      throw new Error(`benchmark ${index + 1} requires name and command fields`);
    }
    const definition = {
      name: String(benchmark.name),
      command: String(benchmark.command),
      working_directory: String(benchmark.working_directory || "."),
      workload: Number(benchmark.workload || 0),
      workload_unit: String(benchmark.workload_unit || "items"),
    };
    if (benchmark.comparison_group) {
      definition.comparison_group = String(benchmark.comparison_group);
      definition.comparison_label = String(benchmark.comparison_label || benchmark.name);
    }
    return definition;
  });
}

function buildMatrix({ benchmarks, threads, strategy, replicas }) {
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`strategy must be one of ${[...STRATEGIES].join(", ")}`);
  }
  const include = [];
  for (const benchmark of benchmarks) {
    const base = {
      benchmark: benchmark.name,
      command: benchmark.command,
      comparison_group: benchmark.comparison_group || "",
      comparison_label: benchmark.comparison_label || benchmark.name,
      working_directory: benchmark.working_directory,
      workload: benchmark.workload,
      workload_unit: benchmark.workload_unit,
    };
    if (strategy === "thread-sharded") {
      for (const thread of threads) {
        include.push({
          ...base,
          id: `${slugify(benchmark.name)}-t${thread}`,
          replica: 1,
          threads: String(thread),
        });
      }
      continue;
    }

    const count = strategy === "replicated-sweep" ? replicas : 1;
    for (let replica = 1; replica <= count; replica += 1) {
      const offset = strategy === "replicated-sweep" ? (replica - 1) % threads.length : 0;
      const orderedThreads = [...threads.slice(offset), ...threads.slice(0, offset)];
      include.push({
        ...base,
        id: `${slugify(benchmark.name)}-r${replica}`,
        replica,
        threads: orderedThreads.join(","),
      });
    }
  }
  return { include };
}

module.exports = { buildMatrix, parseBenchmarks, parseThreadSpec, STRATEGIES };
