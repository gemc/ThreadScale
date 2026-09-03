const fs = require("node:fs");
const path = require("node:path");
const { scaledWorkload } = require("./benchmark");
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

function effectiveSerialFraction(speedup, threads) {
  const measuredSpeedup = Number(speedup);
  const threadCount = Number(threads);
  if (!Number.isFinite(measuredSpeedup) || measuredSpeedup <= 0
      || !Number.isFinite(threadCount) || threadCount <= 1) {
    return null;
  }
  return ((1 / measuredSpeedup) - (1 / threadCount)) / (1 - (1 / threadCount));
}

function workloadForMeasurement(measurement, workload, coresWorkloadScale) {
  const recorded = Number(measurement.workload);
  if (Number.isFinite(recorded) && recorded >= 0) {
    return recorded;
  }
  return scaledWorkload(workload, measurement.threads, coresWorkloadScale);
}

function summarizeReplica(partial, workload, coresWorkloadScale) {
  const measurements = new Map();
  for (const measurement of partial.measurements) {
    const thread = Number(measurement.threads);
    if (!measurements.has(thread)) {
      measurements.set(thread, []);
    }
    measurements.get(thread).push({
      seconds: Number(measurement.seconds),
      workload: workloadForMeasurement(measurement, workload, coresWorkloadScale),
    });
  }
  const points = [...measurements]
    .sort(([left], [right]) => left - right)
    .map(([threads, values]) => {
      const workloads = [...new Set(values.map((value) => value.workload))];
      if (workloads.length !== 1) {
        throw new Error(`replica ${partial.replica || 1} has inconsistent workloads at ${threads} threads`);
      }
      return {
        threads,
        workload: workloads[0],
        ...statistics(values.map((value) => value.seconds)),
      };
    });
  const baseline = points.find((point) => point.threads === 1);
  for (const point of points) {
    if (point.workload > 0) {
      point.median_rate = point.workload / point.median;
    }
    if (baseline) {
      point.speedup = coresWorkloadScale > 0
        ? point.median_rate / baseline.median_rate
        : baseline.median / point.median;
      point.efficiency_percent = (100 * point.speedup) / point.threads;
      point.effective_serial_fraction = coresWorkloadScale > 0
        ? null
        : effectiveSerialFraction(point.speedup, point.threads);
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
    const partialScale = Number(partial.cores_workload_scale || 0);
    const partialWorkload = Number(partial.workload || 0);
    if (!Number.isFinite(partialScale) || partialScale < 0) {
      throw new Error(`${partial.benchmark} has an invalid cores-workload-scale value`);
    }
    if (partialScale > 0 && (!Number.isFinite(partialWorkload) || partialWorkload <= 0)) {
      throw new Error(`${partial.benchmark} workload scaling requires a positive base workload`);
    }
    if (!grouped.has(partial.benchmark)) {
      grouped.set(partial.benchmark, {
        command: partial.command,
        comparison_group: String(partial.comparison_group || ""),
        comparison_label: String(partial.comparison_label || partial.benchmark),
        cores_workload_scale: partialScale,
        measurements: new Map(),
        partials: [],
        runners: [],
        workload: partialWorkload,
        workload_unit: partial.workload_unit || "items",
      });
    }
    const benchmark = grouped.get(partial.benchmark);
    if (partialScale !== benchmark.cores_workload_scale) {
      throw new Error(`${partial.benchmark} partials use inconsistent cores-workload-scale values`);
    }
    if (partialWorkload !== benchmark.workload) {
      throw new Error(`${partial.benchmark} partials use inconsistent base workloads`);
    }
    benchmark.partials.push(partial);
    benchmark.runners.push(partial.runner);
    for (const measurement of partial.measurements) {
      const thread = Number(measurement.threads);
      if (!benchmark.measurements.has(thread)) {
        benchmark.measurements.set(thread, []);
      }
      benchmark.measurements.get(thread).push({
        seconds: Number(measurement.seconds),
        workload: workloadForMeasurement(measurement, benchmark.workload, benchmark.cores_workload_scale),
      });
    }
  }

  const benchmarks = [];
  for (const [name, benchmark] of grouped) {
    const points = [...benchmark.measurements]
      .sort(([left], [right]) => left - right)
      .map(([threads, values]) => {
        const workloads = [...new Set(values.map((value) => value.workload))];
        if (workloads.length !== 1) {
          throw new Error(`${name} has inconsistent workloads at ${threads} threads`);
        }
        return {
          threads,
          workload: workloads[0],
          ...statistics(values.map((value) => value.seconds)),
        };
      });
    const baseline = points.find((point) => point.threads === 1);
    if (!baseline) {
      throw new Error(`${name} has no one-thread baseline`);
    }
    for (const point of points) {
      const pairedSpeedups = [];
      for (const partial of benchmark.partials) {
        const partialBaseline = partial.measurements
          .filter((measurement) => Number(measurement.threads) === 1)
          .map((measurement) => ({
            seconds: Number(measurement.seconds),
            workload: workloadForMeasurement(
              measurement,
              benchmark.workload,
              benchmark.cores_workload_scale,
            ),
          }));
        const partialPoint = partial.measurements
          .filter((measurement) => Number(measurement.threads) === point.threads)
          .map((measurement) => ({
            seconds: Number(measurement.seconds),
            workload: workloadForMeasurement(
              measurement,
              benchmark.workload,
              benchmark.cores_workload_scale,
            ),
          }));
        if (partialBaseline.length > 0 && partialPoint.length > 0) {
          const timeSpeedup = median(partialBaseline.map((measurement) => measurement.seconds))
            / median(partialPoint.map((measurement) => measurement.seconds));
          const workloadRatio = partialPoint[0].workload / partialBaseline[0].workload;
          pairedSpeedups.push(
            benchmark.cores_workload_scale > 0 ? workloadRatio * timeSpeedup : timeSpeedup,
          );
        }
      }
      point.paired_speedup_samples = pairedSpeedups.length;
      if (point.workload > 0) {
        point.median_rate = point.workload / point.median;
        point.mean_rate = point.workload / point.mean;
      }
      point.speedup = pairedSpeedups.length > 0
        ? median(pairedSpeedups)
        : benchmark.cores_workload_scale > 0
          ? point.median_rate / baseline.median_rate
          : baseline.median / point.median;
      point.efficiency_percent = (100 * point.speedup) / point.threads;
      point.effective_serial_fraction = benchmark.cores_workload_scale > 0
        ? null
        : effectiveSerialFraction(point.speedup, point.threads);
    }
    benchmarks.push({
      name,
      command: benchmark.command,
      comparison_group: benchmark.comparison_group,
      comparison_label: benchmark.comparison_label,
      cores_workload_scale: benchmark.cores_workload_scale,
      points,
      replicas: benchmark.partials
        .map((partial) => summarizeReplica(
          partial,
          benchmark.workload,
          benchmark.cores_workload_scale,
        ))
        .sort((left, right) => left.replica - right.replica),
      runners: benchmark.runners,
      speedup_basis: benchmark.cores_workload_scale > 0 ? "throughput" : "runtime",
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
    "workload",
    "cores_workload_scale",
    "speedup_basis",
    "samples",
    "mean_seconds",
    "median_seconds",
    "stddev_seconds",
    "min_seconds",
    "max_seconds",
    "speedup",
    "effective_serial_fraction",
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
        point.workload,
        benchmark.cores_workload_scale,
        benchmark.cores_workload_scale > 0 ? "throughput" : "runtime",
        point.count,
        point.mean,
        point.median,
        point.standard_deviation,
        point.min,
        point.max,
        point.speedup,
        point.effective_serial_fraction ?? "",
        point.paired_speedup_samples,
        point.efficiency_percent,
        point.median_rate || "",
        benchmark.workload > 0 ? benchmark.workload_unit : "",
      ]);
    }
  }
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function mermaidCoordinate(value) {
  return Number(value.toPrecision(8));
}

function mermaidLine(points, value) {
  const values = points.map((point) => mermaidCoordinate(value(point))).join(", ");
  return `    line [${values}]`;
}

function renderMeasuredPoints(benchmark, value, unit, options = {}) {
  const marker = options.marker || "🔵";
  const labels = benchmark.points.map((point) => {
    const threadLabel = `${point.threads} thread${point.threads === 1 ? "" : "s"}`;
    return `${options.label ? "" : `${marker} `}\`${threadLabel}: `
      + `${numberLabel(value(point))} ${unit}\``;
  });
  const heading = options.label ? `**${marker} ${options.label}:**` : "**Measured points:**";
  return `${heading} ${labels.join(" · ")}`;
}

function mermaidChartHeader() {
  return [
    "---",
    "config:",
    "  themeVariables:",
    "    xyChart:",
    '      plotColorPalette: "#0969da, #cf6a00, #1a7f37, #8250df"',
    "---",
    "xychart",
  ];
}

function renderMermaidTimeChart(benchmark) {
  const title = `${benchmark.name}: time vs threads`.replace(/["\n\r]/g, "'");
  const threads = benchmark.points.map((point) => point.threads).join(", ");
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
    mermaidLine(benchmark.points, (point) => point.median),
    "```",
    "",
    renderMeasuredPoints(benchmark, (point) => point.median, "s"),
  ].join("\n");
}

function renderMermaidRateChart(benchmark) {
  const title = `${benchmark.name}: rate vs threads`.replace(/["\n\r]/g, "'");
  const unit = String(benchmark.workload_unit).replace(/["\n\r]/g, "'");
  const threads = benchmark.points.map((point) => point.threads).join(", ");
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
    mermaidLine(benchmark.points, (point) => point.median_rate),
    "```",
    "",
    renderMeasuredPoints(benchmark, (point) => point.median_rate, `${unit}/s`),
  ].join("\n");
}

function comparisonGroups(benchmarks) {
  const groups = new Map();
  for (const benchmark of benchmarks) {
    if (!benchmark.comparison_group) {
      continue;
    }
    if (!groups.has(benchmark.comparison_group)) {
      groups.set(benchmark.comparison_group, []);
    }
    groups.get(benchmark.comparison_group).push(benchmark);
  }
  return [...groups].filter(([, members]) => members.length > 1);
}

function validateComparison(benchmarks, valueName) {
  const referenceThreads = benchmarks[0].points.map((point) => point.threads).join(",");
  for (const benchmark of benchmarks.slice(1)) {
    const threads = benchmark.points.map((point) => point.threads).join(",");
    if (threads !== referenceThreads) {
      throw new Error(
        `comparison group ${benchmark.comparison_group} requires identical thread counts; `
          + `received ${referenceThreads} and ${threads}`,
      );
    }
  }
  if (valueName === "rate") {
    const unit = benchmarks[0].workload_unit;
    if (benchmarks.some((benchmark) => benchmark.workload <= 0 || benchmark.workload_unit !== unit)) {
      throw new Error(
        `comparison group ${benchmarks[0].comparison_group} requires positive workloads with one unit`,
      );
    }
    const referenceWorkloads = benchmarks[0].points.map((point) => point.workload).join(",");
    if (benchmarks.some((benchmark) =>
      benchmark.points.map((point) => point.workload).join(",") !== referenceWorkloads)) {
      throw new Error(
        `comparison group ${benchmarks[0].comparison_group} requires identical workloads`,
      );
    }
  }
}

function renderMermaidComparisonChart(benchmarks, valueName) {
  validateComparison(benchmarks, valueName);
  const group = String(benchmarks[0].comparison_group).replace(/["\n\r]/g, "'");
  const isRate = valueName === "rate";
  const heading = isRate ? "Rate vs threads" : "Time vs threads";
  const unit = isRate ? `${benchmarks[0].workload_unit} / second` : "Median time (seconds)";
  const value = isRate ? (point) => point.median_rate : (point) => point.median;
  const threads = benchmarks[0].points.map((point) => point.threads).join(", ");
  const maximum = Math.max(
    ...benchmarks.flatMap((benchmark) => benchmark.points.map((point) => value(point))),
    Number.EPSILON,
  );
  const yMaximum = Number((maximum * 1.1).toPrecision(8));
  const markers = ["🔵", "🟠", "🟢", "🟣"];
  const legend = benchmarks.map((benchmark, index) => {
    const label = benchmark.comparison_label || benchmark.name;
    return `${markers[index % markers.length]} ${label}`;
  }).join(" · ");
  return [
    `## ${group}`,
    "",
    `### ${heading}`,
    "",
    `**Series:** ${legend}`,
    "",
    "```mermaid",
    ...mermaidChartHeader(),
    `    title "${group}: ${valueName} vs threads"`,
    `    x-axis "Threads" [${threads}]`,
    `    y-axis "${unit}" 0 --> ${yMaximum}`,
    ...benchmarks.map((benchmark) => mermaidLine(benchmark.points, value)),
    "```",
    "",
    ...benchmarks.map((benchmark, index) => renderMeasuredPoints(
      benchmark,
      value,
      isRate ? `${benchmark.workload_unit}/s` : "s",
      {
        label: benchmark.comparison_label || benchmark.name,
        marker: markers[index % markers.length],
      },
    )),
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
  const comparisons = comparisonGroups(benchmarks);
  const comparedBenchmarks = new Set(comparisons.flatMap(([, members]) => members));
  const lines = ["# Thread Scaling Results", ""];
  for (const benchmark of benchmarks) {
    const throughputScaling = benchmark.cores_workload_scale > 0;
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
    if (throughputScaling) {
      lines.push(
        `Workload scaling: \`W(N) = ${benchmark.workload} × `
          + `[1 + (N - 1) × ${benchmark.cores_workload_scale}]\` ${benchmark.workload_unit}.`,
        "",
      );
    }
    if (benchmark.workload > 0) {
      if (throughputScaling) {
        lines.push(
          "| Threads | Workload | Median time | Std. dev. | Throughput speedup | Efficiency | "
            + "Median rate | Samples |",
          "|---:|---:|---:|---:|---:|---:|---:|---:|",
        );
      } else {
        lines.push(
          "| Threads | Median time | Std. dev. | Speedup | Efficiency | Effective serial | "
            + "Median rate | Samples |",
          "|---:|---:|---:|---:|---:|---:|---:|---:|",
        );
      }
    } else {
      lines.push(
        "| Threads | Median time | Std. dev. | Speedup | Efficiency | Effective serial | Samples |",
        "|---:|---:|---:|---:|---:|---:|---:|",
      );
    }
    for (const point of benchmark.points) {
      const cells = [String(point.threads)];
      if (throughputScaling) {
        cells.push(`${point.workload} ${benchmark.workload_unit}`);
      }
      cells.push(
        `${point.median.toFixed(3)} s`,
        `${point.standard_deviation.toFixed(3)} s`,
        `${point.speedup.toFixed(2)}x`,
        `${point.efficiency_percent.toFixed(1)}%`,
      );
      if (!throughputScaling) {
        cells.push(Number.isFinite(point.effective_serial_fraction)
          ? `${(100 * point.effective_serial_fraction).toFixed(1)}%`
          : "—");
      }
      if (benchmark.workload > 0) {
        cells.push(`${point.median_rate.toFixed(2)} ${benchmark.workload_unit}/s`);
      }
      cells.push(String(point.count));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    if (throughputScaling) {
      lines.push(
        "",
        "> **Throughput scaling:** Speedup is `rate(N) / rate(1)` and efficiency is "
          + "`speedup / N × 100%`.",
        "> The Karp–Flatt effective serial estimate is omitted because workloads differ by thread count.",
        "",
      );
    } else {
      lines.push(
        "",
        "> **Effective serial fraction:** Lower is better. This Amdahl/Karp–Flatt estimate approximates",
        "> how much of the application's execution behaves serially. It also includes parallel overhead and",
        "> contention, so it is not a literal percentage of source code.",
        "> Negative values can result from superlinear scaling or measurement noise.",
        "",
      );
    }
    const replicaSweeps = benchmark.replicas.filter((replica) =>
      replica.points.length > 1 && replica.points.some((point) => point.threads === 1));
    if (replicaSweeps.length > 0) {
      lines.push("<details>", `<summary>Per-replica sweeps (${replicaSweeps.length})</summary>`, "");
      if (throughputScaling) {
        lines.push(
          "| Replica | Runner | Threads | Workload | Median time | Throughput speedup | Median rate |",
          "|---:|:---|---:|---:|---:|---:|---:|",
        );
      } else {
        lines.push(
          "| Replica | Runner | Threads | Median time | Speedup | Effective serial | Median rate |",
          "|---:|:---|---:|---:|---:|---:|---:|",
        );
      }
      for (const replica of replicaSweeps) {
        for (const [index, point] of replica.points.entries()) {
          const rate = benchmark.workload > 0
            ? `${point.median_rate.toFixed(2)} ${benchmark.workload_unit}/s`
            : "—";
          const effectiveSerial = Number.isFinite(point.effective_serial_fraction)
            ? `${(100 * point.effective_serial_fraction).toFixed(1)}%`
            : "—";
          const prefix = `| ${index === 0 ? replica.replica : ""} | `
            + `${index === 0 ? runnerDescription(replica.runner) : ""} | ${point.threads} | `;
          const row = throughputScaling
            ? `${point.workload} ${benchmark.workload_unit} | ${point.median.toFixed(3)} s | `
              + `${point.speedup.toFixed(2)}x | ${rate} |`
            : `${point.median.toFixed(3)} s | ${point.speedup.toFixed(2)}x | `
              + `${effectiveSerial} | ${rate} |`;
          lines.push(prefix + row);
        }
      }
      lines.push("", "</details>", "");
    }
    if (!comparedBenchmarks.has(benchmark)
        && (plotSelection === "time" || plotSelection === "both")) {
      lines.push(renderMermaidTimeChart(benchmark), "");
    }
    if (!comparedBenchmarks.has(benchmark)
        && (plotSelection === "rate" || plotSelection === "both")) {
      if (benchmark.workload > 0) {
        lines.push(renderMermaidRateChart(benchmark), "");
      } else {
        lines.push("### Rate vs threads", "", "_Set `workload` above zero to display a rate plot._", "");
      }
    }
  }
  for (const [, members] of comparisons) {
    if (plotSelection === "time" || plotSelection === "both") {
      lines.push(renderMermaidComparisonChart(members, "time"), "");
    }
    if (plotSelection === "rate" || plotSelection === "both") {
      lines.push(renderMermaidComparisonChart(members, "rate"), "");
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
  const throughputScaling = benchmark.cores_workload_scale > 0;
  const timePoints = benchmark.points.map((point) => ({ x: point.threads, y: point.median }));
  const baseline = benchmark.points.find((point) => point.threads === 1);
  const idealTime = benchmark.points.map((point) => ({
    x: point.threads,
    y: (baseline.median * (throughputScaling ? point.workload / baseline.workload : 1)) / point.threads,
  }));
  fs.writeFileSync(path.join(directory, "time-vs-threads.svg"), renderChart({
    ideal: idealTime,
    points: timePoints,
    title: `${benchmark.name}: runtime scaling`,
    yLabel: "Median time (seconds)",
  }));
  fs.writeFileSync(path.join(directory, "speedup-vs-threads.svg"), renderChart({
    ideal: benchmark.points.map((point) => ({ x: point.threads, y: point.threads })),
    points: benchmark.points.map((point) => ({ x: point.threads, y: point.speedup })),
    title: `${benchmark.name}: ${throughputScaling ? "throughput " : ""}speedup`,
    yLabel: throughputScaling ? "Throughput speedup" : "Speedup",
  }));
  fs.writeFileSync(path.join(directory, "efficiency-vs-threads.svg"), renderChart({
    ideal: benchmark.points.map((point) => ({ x: point.threads, y: 100 })),
    points: benchmark.points.map((point) => ({ x: point.threads, y: point.efficiency_percent })),
    title: `${benchmark.name}: ${throughputScaling ? "throughput " : "parallel "}efficiency`,
    yLabel: throughputScaling ? "Throughput efficiency (%)" : "Efficiency (%)",
  }));
  if (benchmark.workload > 0) {
    fs.writeFileSync(path.join(directory, "rate-vs-threads.svg"), renderChart({
      ideal: throughputScaling
        ? benchmark.points.map((point) => ({ x: point.threads, y: baseline.median_rate * point.threads }))
        : undefined,
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
    const replicaBaseline = replica.points.find((point) => point.threads === 1);
    fs.writeFileSync(path.join(replicaDirectory, "time-vs-threads.svg"), renderChart({
      ideal: replica.points.map((point) => ({
        x: point.threads,
        y: (replicaBaseline.median
          * (throughputScaling ? point.workload / replicaBaseline.workload : 1)) / point.threads,
      })),
      points: replica.points.map((point) => ({ x: point.threads, y: point.median })),
      title: `${titlePrefix}: runtime scaling`,
      yLabel: "Median time (seconds)",
    }));
    fs.writeFileSync(path.join(replicaDirectory, "speedup-vs-threads.svg"), renderChart({
      ideal: replica.points.map((point) => ({ x: point.threads, y: point.threads })),
      points: replica.points.map((point) => ({ x: point.threads, y: point.speedup })),
      title: `${titlePrefix}: ${throughputScaling ? "throughput " : ""}speedup`,
      yLabel: throughputScaling ? "Throughput speedup" : "Speedup",
    }));
    if (benchmark.workload > 0) {
      fs.writeFileSync(path.join(replicaDirectory, "rate-vs-threads.svg"), renderChart({
        ideal: throughputScaling
          ? replica.points.map((point) => ({
            x: point.threads,
            y: replicaBaseline.median_rate * point.threads,
          }))
          : undefined,
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
  effectiveSerialFraction,
  loadPartials,
  mean,
  median,
  renderChart,
  renderMermaidComparisonChart,
  renderMermaidRateChart,
  renderMermaidTimeChart,
  statistics,
  validateSummaryPlots,
};
