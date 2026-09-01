const fs = require("node:fs");
const path = require("node:path");
const { ensureDirectory, slugify, walkJsonFiles } = require("./utils");

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function statistics(values) {
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return {
    count: values.length,
    max: Math.max(...values),
    mean: average,
    median: median(values),
    min: Math.min(...values),
    standard_deviation: Math.sqrt(variance),
  };
}

function summarizeReplica(partial, workload) {
  const measurements = new Map();
  for (const measurement of partial.measurements) {
    const thread = Number(measurement.threads);
    if (!measurements.has(thread)) {
      measurements.set(thread, []);
    }
    measurements.get(thread).push(Number(measurement.seconds));
  }
  const points = [...measurements]
    .sort(([left], [right]) => left - right)
    .map(([threads, values]) => ({ threads, ...statistics(values) }));
  const baseline = points.find((point) => point.threads === 1);
  for (const point of points) {
    if (baseline) {
      point.speedup = baseline.median / point.median;
      point.efficiency_percent = (100 * point.speedup) / point.threads;
    }
    if (workload > 0) {
      point.median_rate = workload / point.median;
    }
  }
  return {
    points,
    replica: Number(partial.replica || 1),
    runner: partial.runner || {},
  };
}

function loadPartials(inputDirectory) {
  const partials = [];
  for (const filename of walkJsonFiles(inputDirectory)) {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      throw new Error(`cannot parse ${filename}: ${error.message}`);
    }
    if (value.kind === "thread-scale-partial") {
      partials.push(value);
    }
  }
  if (partials.length === 0) {
    throw new Error(`no ThreadScale partial JSON files found under ${inputDirectory}`);
  }
  return partials;
}

function aggregate(partials) {
  const grouped = new Map();
  for (const partial of partials) {
    if (!grouped.has(partial.benchmark)) {
      grouped.set(partial.benchmark, {
        command: partial.command,
        measurements: new Map(),
        partials: [],
        runners: [],
        workload: Number(partial.workload || 0),
        workload_unit: partial.workload_unit || "items",
      });
    }
    const benchmark = grouped.get(partial.benchmark);
    benchmark.partials.push(partial);
    benchmark.runners.push(partial.runner);
    for (const measurement of partial.measurements) {
      const thread = Number(measurement.threads);
      if (!benchmark.measurements.has(thread)) {
        benchmark.measurements.set(thread, []);
      }
      benchmark.measurements.get(thread).push(Number(measurement.seconds));
    }
  }

  const benchmarks = [];
  for (const [name, benchmark] of grouped) {
    const points = [...benchmark.measurements]
      .sort(([left], [right]) => left - right)
      .map(([threads, values]) => ({ threads, ...statistics(values) }));
    const baseline = points.find((point) => point.threads === 1);
    if (!baseline) {
      throw new Error(`${name} has no one-thread baseline`);
    }
    for (const point of points) {
      const pairedSpeedups = [];
      for (const partial of benchmark.partials) {
        const partialBaseline = partial.measurements
          .filter((measurement) => Number(measurement.threads) === 1)
          .map((measurement) => Number(measurement.seconds));
        const partialPoint = partial.measurements
          .filter((measurement) => Number(measurement.threads) === point.threads)
          .map((measurement) => Number(measurement.seconds));
        if (partialBaseline.length > 0 && partialPoint.length > 0) {
          pairedSpeedups.push(median(partialBaseline) / median(partialPoint));
        }
      }
      point.paired_speedup_samples = pairedSpeedups.length;
      point.speedup = pairedSpeedups.length > 0
        ? median(pairedSpeedups)
        : baseline.median / point.median;
      point.efficiency_percent = (100 * point.speedup) / point.threads;
      if (benchmark.workload > 0) {
        point.median_rate = benchmark.workload / point.median;
        point.mean_rate = benchmark.workload / point.mean;
      }
    }
    benchmarks.push({
      name,
      command: benchmark.command,
      points,
      replicas: benchmark.partials
        .map((partial) => summarizeReplica(partial, benchmark.workload))
        .sort((left, right) => left.replica - right.replica),
      runners: benchmark.runners,
      workload: benchmark.workload,
      workload_unit: benchmark.workload_unit,
    });
  }
  return benchmarks.sort((left, right) => left.name.localeCompare(right.name));
}

function topologyDescription(runner) {
  const parts = [];
  if (runner.physical_cores) {
    parts.push(`${runner.physical_cores} OS physical cores`);
  }
  if (runner.threads_per_core) {
    parts.push(`${runner.threads_per_core} threads/core`);
  }
  if (runner.sockets) {
    parts.push(`${runner.sockets} socket${runner.sockets === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function runnerDescription(runner) {
  return [
    runner.cpu_model || "unknown CPU",
    topologyDescription(runner),
    `${runner.platform || "unknown OS"} ${runner.release || ""}`.trim(),
    runner.architecture || "unknown architecture",
    `${runner.visible_cpus} visible CPUs`,
    runner.affinity || "affinity unavailable",
  ].filter(Boolean).join("; ");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function numberLabel(value) {
  if (value >= 1000 || (value > 0 && value < 0.01)) {
    return value.toExponential(2);
  }
  return value.toFixed(value >= 10 ? 1 : 2);
}

function renderChart({ ideal, points, title, yLabel }) {
  const width = 820;
  const height = 500;
  const margin = { bottom: 72, left: 90, right: 35, top: 58 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const xValues = points.map((point) => point.x);
  const allY = [...points.map((point) => point.y), ...(ideal || []).map((point) => point.y)];
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMax = Math.max(...allY, Number.EPSILON) * 1.08;
  const x = (value) => margin.left + ((value - xMin) / Math.max(1, xMax - xMin)) * plotWidth;
  const y = (value) => margin.top + plotHeight - (value / yMax) * plotHeight;
  const measuredLine = points.map((point) => `${x(point.x)},${y(point.y)}`).join(" ");
  const idealLine = ideal?.map((point) => `${x(point.x)},${y(point.y)}`).join(" ");
  const yTicks = Array.from({ length: 6 }, (_, index) => (index * yMax) / 5);

  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
      + `viewBox="0 0 ${width} ${height}">`,
    "<style>",
    "text{font-family:system-ui,-apple-system,sans-serif;fill:#24292f}",
    ".grid{stroke:#d8dee4;stroke-width:1}.axis{stroke:#57606a;stroke-width:1.5}",
    ".measured{fill:none;stroke:#0969da;stroke-width:3}",
    ".point{fill:#0969da;stroke:#fff;stroke-width:2}",
    ".point-label{font-size:12px;font-weight:600;paint-order:stroke;stroke:#fff;stroke-width:4px}",
    ".ideal{fill:none;stroke:#8c959f;stroke-width:2;stroke-dasharray:7 6}",
    "</style>",
    `<rect width="${width}" height="${height}" fill="#fff"/>`,
    `<text x="${width / 2}" y="31" text-anchor="middle" font-size="21" font-weight="600">`
      + `${xmlEscape(title)}</text>`,
  ];
  for (const tick of yTicks) {
    lines.push(
      `<line class="grid" x1="${margin.left}" y1="${y(tick)}" `
        + `x2="${width - margin.right}" y2="${y(tick)}"/>`,
    );
    lines.push(
      `<text x="${margin.left - 12}" y="${y(tick) + 4}" text-anchor="end" font-size="12">`
        + `${numberLabel(tick)}</text>`,
    );
  }
  for (const tick of xValues) {
    lines.push(
      `<text x="${x(tick)}" y="${height - margin.bottom + 25}" text-anchor="middle" `
        + `font-size="12">${tick}</text>`,
    );
  }
  lines.push(
    `<line class="axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" `
      + `y2="${height - margin.bottom}"/>`,
  );
  lines.push(
    `<line class="axis" x1="${margin.left}" y1="${height - margin.bottom}" `
      + `x2="${width - margin.right}" y2="${height - margin.bottom}"/>`,
  );
  lines.push(
    `<text x="${width / 2}" y="${height - 18}" text-anchor="middle" `
      + 'font-size="14">Threads</text>',
  );
  lines.push(
    `<text x="20" y="${height / 2}" text-anchor="middle" font-size="14" `
      + `transform="rotate(-90 20 ${height / 2})">${xmlEscape(yLabel)}</text>`,
  );
  if (idealLine) {
    lines.push(`<polyline class="ideal" points="${idealLine}"/>`);
  }
  lines.push(`<polyline class="measured" points="${measuredLine}"/>`);
  for (const [index, point] of points.entries()) {
    const pointX = x(point.x);
    const pointY = y(point.y);
    const first = points.length > 1 && index === 0;
    const last = points.length > 1 && index === points.length - 1;
    const labelX = pointX + (first ? 9 : last ? -9 : 0);
    const labelAnchor = first ? "start" : last ? "end" : "middle";
    lines.push(
      `<circle class="point" cx="${pointX}" cy="${pointY}" r="6">`
        + `<title>${point.x} threads: ${numberLabel(point.y)}</title></circle>`,
    );
    lines.push(
      `<text class="point-label" x="${labelX}" y="${pointY - 12}" `
        + `text-anchor="${labelAnchor}">${numberLabel(point.y)}</text>`,
    );
  }
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(benchmarks) {
  const rows = [[
    "benchmark",
    "threads",
    "samples",
    "mean_seconds",
    "median_seconds",
    "stddev_seconds",
    "min_seconds",
    "max_seconds",
    "speedup",
    "paired_speedup_samples",
    "efficiency_percent",
    "median_rate",
    "workload_unit_per_second",
  ]];
  for (const benchmark of benchmarks) {
    for (const point of benchmark.points) {
      rows.push([
        benchmark.name,
        point.threads,
        point.count,
        point.mean,
        point.median,
        point.standard_deviation,
        point.min,
        point.max,
        point.speedup,
        point.paired_speedup_samples,
        point.efficiency_percent,
        point.median_rate || "",
        benchmark.workload > 0 ? benchmark.workload_unit : "",
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function mermaidPoint(value) {
  const coordinate = Number(value.toPrecision(8));
  return `${coordinate} "● ${numberLabel(value)}"`;
}

function mermaidChartHeader() {
  return [
    "---",
    "config:",
    "  themeCSS: |",
    "    .line-plot-0 .labels text:first-child { text-anchor: start; }",
    "    .line-plot-0 .labels text:last-child { text-anchor: end; }",
    "  themeVariables:",
    "    xyChart:",
    '      plotColorPalette: "#0969da"',
    "---",
    "xychart",
  ];
}

function renderMermaidTimeChart(benchmark) {
  const title = `${benchmark.name}: time vs threads`.replace(/["\n\r]/g, "'");
  const threads = benchmark.points.map((point) => point.threads).join(", ");
  const times = benchmark.points.map((point) => mermaidPoint(point.median)).join(", ");
  const maximum = Math.max(...benchmark.points.map((point) => point.median), Number.EPSILON);
  const yMaximum = Number((maximum * 1.1).toPrecision(8));
  return [
    "### Time vs threads",
    "",
    "```mermaid",
    ...mermaidChartHeader(),
    `    title "${title}"`,
    `    x-axis "Threads" [${threads}]`,
    `    y-axis "Median time (seconds)" 0 --> ${yMaximum}`,
    `    line [${times}]`,
    "```",
  ].join("\n");
}

function renderMermaidRateChart(benchmark) {
  const title = `${benchmark.name}: rate vs threads`.replace(/["\n\r]/g, "'");
  const unit = String(benchmark.workload_unit).replace(/["\n\r]/g, "'");
  const threads = benchmark.points.map((point) => point.threads).join(", ");
  const rates = benchmark.points.map((point) => mermaidPoint(point.median_rate)).join(", ");
  const maximum = Math.max(...benchmark.points.map((point) => point.median_rate), Number.EPSILON);
  const yMaximum = Number((maximum * 1.1).toPrecision(8));
  return [
    "### Rate vs threads",
    "",
    "```mermaid",
    ...mermaidChartHeader(),
    `    title "${title}"`,
    `    x-axis "Threads" [${threads}]`,
    `    y-axis "${unit} / second" 0 --> ${yMaximum}`,
    `    line [${rates}]`,
    "```",
  ].join("\n");
}

function validateSummaryPlots(value) {
  const selection = String(value || "both").toLowerCase();
  if (!["none", "time", "rate", "both"].includes(selection)) {
    throw new Error(`summary-plots must be none, time, rate, or both; received ${value}`);
  }
  return selection;
}

function buildMarkdown(benchmarks, summaryPlots = "both") {
  const plotSelection = validateSummaryPlots(summaryPlots);
  const lines = ["# Thread Scaling Results", ""];
  for (const benchmark of benchmarks) {
    lines.push(`## ${benchmark.name}`, "");
    const runners = new Map();
    for (const runner of benchmark.runners) {
      const description = runnerDescription(runner);
      runners.set(description, (runners.get(description) || 0) + 1);
    }
    lines.push("Runner configurations:", "");
    for (const [description, count] of runners) {
      lines.push(`- ${count} measurement job${count === 1 ? "" : "s"}: ${description}`);
    }
    lines.push("");
    if (benchmark.workload > 0) {
      lines.push(
        "| Threads | Median time | Std. dev. | Speedup | Efficiency | Median rate | Samples |",
        "|---:|---:|---:|---:|---:|---:|---:|",
      );
    } else {
      lines.push(
        "| Threads | Median time | Std. dev. | Speedup | Efficiency | Samples |",
        "|---:|---:|---:|---:|---:|---:|",
      );
    }
    for (const point of benchmark.points) {
      const cells = [
        String(point.threads),
        `${point.median.toFixed(3)} s`,
        `${point.standard_deviation.toFixed(3)} s`,
        `${point.speedup.toFixed(2)}x`,
        `${point.efficiency_percent.toFixed(1)}%`,
      ];
      if (benchmark.workload > 0) {
        cells.push(`${point.median_rate.toFixed(2)} ${benchmark.workload_unit}/s`);
      }
      cells.push(String(point.count));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
    const replicaSweeps = benchmark.replicas.filter((replica) =>
      replica.points.length > 1 && replica.points.some((point) => point.threads === 1));
    if (replicaSweeps.length > 0) {
      lines.push(
        "<details>",
        `<summary>Per-replica sweeps (${replicaSweeps.length})</summary>`,
        "",
        "| Replica | Runner | Threads | Median time | Speedup | Median rate |",
        "|---:|:---|---:|---:|---:|---:|",
      );
      for (const replica of replicaSweeps) {
        for (const [index, point] of replica.points.entries()) {
          const rate = benchmark.workload > 0
            ? `${point.median_rate.toFixed(2)} ${benchmark.workload_unit}/s`
            : "—";
          lines.push(
            `| ${index === 0 ? replica.replica : ""} | `
              + `${index === 0 ? runnerDescription(replica.runner) : ""} | ${point.threads} | `
              + `${point.median.toFixed(3)} s | ${point.speedup.toFixed(2)}x | ${rate} |`,
          );
        }
      }
      lines.push("", "</details>", "");
    }
    if (plotSelection === "time" || plotSelection === "both") {
      lines.push(renderMermaidTimeChart(benchmark), "");
    }
    if (plotSelection === "rate" || plotSelection === "both") {
      if (benchmark.workload > 0) {
        lines.push(renderMermaidRateChart(benchmark), "");
      } else {
        lines.push("### Rate vs threads", "", "_Set `workload` above zero to display a rate plot._", "");
      }
    }
  }
  lines.push(
    "> For publication-quality results, use an otherwise idle machine with stable CPU placement and frequency.",
    "",
  );
  return lines.join("\n");
}

function writeCharts(benchmark, outputDirectory) {
  const directory = path.join(outputDirectory, slugify(benchmark.name));
  ensureDirectory(directory);
  const timePoints = benchmark.points.map((point) => ({ x: point.threads, y: point.median }));
  const baseline = benchmark.points.find((point) => point.threads === 1).median;
  const idealTime = benchmark.points.map((point) => ({ x: point.threads, y: baseline / point.threads }));
  fs.writeFileSync(path.join(directory, "time-vs-threads.svg"), renderChart({
    ideal: idealTime,
    points: timePoints,
    title: `${benchmark.name}: runtime scaling`,
    yLabel: "Median time (seconds)",
  }));
  fs.writeFileSync(path.join(directory, "speedup-vs-threads.svg"), renderChart({
    ideal: benchmark.points.map((point) => ({ x: point.threads, y: point.threads })),
    points: benchmark.points.map((point) => ({ x: point.threads, y: point.speedup })),
    title: `${benchmark.name}: speedup`,
    yLabel: "Speedup",
  }));
  fs.writeFileSync(path.join(directory, "efficiency-vs-threads.svg"), renderChart({
    ideal: benchmark.points.map((point) => ({ x: point.threads, y: 100 })),
    points: benchmark.points.map((point) => ({ x: point.threads, y: point.efficiency_percent })),
    title: `${benchmark.name}: parallel efficiency`,
    yLabel: "Efficiency (%)",
  }));
  if (benchmark.workload > 0) {
    fs.writeFileSync(path.join(directory, "rate-vs-threads.svg"), renderChart({
      points: benchmark.points.map((point) => ({ x: point.threads, y: point.median_rate })),
      title: `${benchmark.name}: throughput scaling`,
      yLabel: `${benchmark.workload_unit} / second`,
    }));
  }
  for (const replica of benchmark.replicas) {
    if (replica.points.length < 2 || !replica.points.some((point) => point.threads === 1)) {
      continue;
    }
    const replicaDirectory = path.join(directory, "replicas", `replica-${replica.replica}`);
    ensureDirectory(replicaDirectory);
    const titlePrefix = `${benchmark.name}, replica ${replica.replica}`;
    const replicaBaseline = replica.points.find((point) => point.threads === 1).median;
    fs.writeFileSync(path.join(replicaDirectory, "time-vs-threads.svg"), renderChart({
      ideal: replica.points.map((point) => ({ x: point.threads, y: replicaBaseline / point.threads })),
      points: replica.points.map((point) => ({ x: point.threads, y: point.median })),
      title: `${titlePrefix}: runtime scaling`,
      yLabel: "Median time (seconds)",
    }));
    fs.writeFileSync(path.join(replicaDirectory, "speedup-vs-threads.svg"), renderChart({
      ideal: replica.points.map((point) => ({ x: point.threads, y: point.threads })),
      points: replica.points.map((point) => ({ x: point.threads, y: point.speedup })),
      title: `${titlePrefix}: speedup`,
      yLabel: "Speedup",
    }));
    if (benchmark.workload > 0) {
      fs.writeFileSync(path.join(replicaDirectory, "rate-vs-threads.svg"), renderChart({
        points: replica.points.map((point) => ({ x: point.threads, y: point.median_rate })),
        title: `${titlePrefix}: throughput scaling`,
        yLabel: `${benchmark.workload_unit} / second`,
      }));
    }
  }
}

function createReport({ inputDirectory, minimumEfficiency, outputDirectory, summaryPlots = "both" }) {
  const partials = loadPartials(inputDirectory);
  const benchmarks = aggregate(partials);
  ensureDirectory(outputDirectory);
  for (const benchmark of benchmarks) {
    writeCharts(benchmark, outputDirectory);
  }
  const report = {
    schema_version: 1,
    kind: "thread-scale-report",
    created_at: new Date().toISOString(),
    partial_files: partials.length,
    benchmarks,
  };
  const jsonFile = path.join(outputDirectory, "scaling.json");
  const csvFile = path.join(outputDirectory, "scaling.csv");
  const summaryFile = path.join(outputDirectory, "summary.md");
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(csvFile, buildCsv(benchmarks), "utf8");
  fs.writeFileSync(summaryFile, `${buildMarkdown(benchmarks, summaryPlots)}\n`, "utf8");

  const failures = [];
  if (minimumEfficiency > 0) {
    for (const benchmark of benchmarks) {
      const last = benchmark.points.at(-1);
      if (last.efficiency_percent / 100 < minimumEfficiency) {
        failures.push(
          `${benchmark.name}: ${last.efficiency_percent.toFixed(1)}% efficiency at ${last.threads} threads`,
        );
      }
    }
  }
  return { csvFile, failures, jsonFile, report, summaryFile };
}

module.exports = {
  aggregate,
  buildCsv,
  buildMarkdown,
  createReport,
  loadPartials,
  mean,
  median,
  renderChart,
  renderMermaidRateChart,
  renderMermaidTimeChart,
  statistics,
  validateSummaryPlots,
};
