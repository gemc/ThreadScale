# ThreadScale

[![Test](https://github.com/gemc/ThreadScale/actions/workflows/test.yml/badge.svg)][test-workflow]

ThreadScale is a language-independent GitHub Action for measuring application strong scaling. It runs the same
command at several thread counts and reports runtime, throughput, speedup, and parallel efficiency. It also
ships a reusable workflow that discovers the runner's CPUs, fans measurements out to dynamic matrix jobs,
transfers partial results through artifacts, and produces the final report.

It works with command-line thread arguments and environment variables such as `OMP_NUM_THREADS`,
`MKL_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `JULIA_NUM_THREADS`, and `RAYON_NUM_THREADS`.

## Quick start: one-job sweep

```yaml
- name: Measure thread scaling
  uses: gemc/ThreadScale@v1
  with:
    command: ./myprogram --threads {threads}
    threads: auto
    runs: 5
    warmup-runs: 1
```

`threads: auto` measures every visible count from `1` through `N`. To reduce the number of points, use
`threads: powers-of-two`; the largest visible count is always included. Explicit lists and ranges are supported:

```yaml
threads: 1,2,4,8
# or
threads: 1-8
```

For OpenMP or another environment-variable interface:

```yaml
- uses: gemc/ThreadScale@v1
  with:
    command: ./myprogram
    thread-env: OMP_NUM_THREADS
    threads: powers-of-two
```

The command template also accepts `{run}`, `{replica}`, and `{benchmark}` placeholders. These are useful for
giving every invocation a distinct output filename.

## Distributed modes

GitHub does not allow a step-level Action to add workflow jobs after a job starts. ThreadScale therefore
includes a reusable workflow for discovery, dynamic fan-out, artifact transfer, and final aggregation.

| Strategy | Matrix entry | Best use |
|---|---|---|
| `single-sweep` | One complete sweep per benchmark | Fast pull-request signal |
| `thread-sharded` | One benchmark and one thread count | Lower runtime per job; cross-VM comparisons |
| `replicated-sweep` | Complete sweep per replica | Hosted-runner statistics and paired comparisons |

`replicated-sweep` is the recommended statistical mode. Each replica measures every count on one VM, avoiding a
comparison in which every point necessarily comes from a different hosted runner. With `replicas: auto`, the
workflow creates one replica per tested thread count. Reported speedup is the median of the within-replica
speedups; sharded measurements fall back to the ratio of aggregated median times.

```yaml
name: Scaling

on:
  workflow_dispatch:

jobs:
  scaling:
    uses: gemc/ThreadScale/.github/workflows/thread-scaling.yml@v1
    with:
      strategy: replicated-sweep
      threads: auto
      runs: 5
      warmup-runs: 1
      setup-command: cmake -S . -B build && cmake --build build --parallel
      benchmarks: >-
        [
          {
            "name": "solver",
            "command": "./build/solver --threads {threads} --input medium.dat",
            "working_directory": ".",
            "workload": 1000000,
            "workload_unit": "cells"
          }
        ]
```

The reusable workflow checks out the caller repository in every measurement job. `setup-command` is optional and
runs once in each such job. Projects with expensive builds can instead download a prebuilt artifact in that
command or copy the three-job discovery/benchmark/report pattern from the reusable workflow into their own CI.

## Results

Benchmark mode writes one portable partial JSON file. Report mode recursively merges partials and creates:

```text
thread-scaling/
├── scaling.csv
├── scaling.json
├── summary.md
└── benchmark-name/
    ├── efficiency-vs-threads.svg
    ├── rate-vs-threads.svg
    ├── speedup-vs-threads.svg
    └── time-vs-threads.svg
```

The rate plot is generated when `workload` is greater than zero. All plots are dependency-free SVG files that
remain sharp in the GitHub job summary, downloaded artifacts, and project documentation. Runtime and speedup
plots include ideal-scaling reference lines.

The job summary contains a table like this:

```text
Threads   Median time   Speedup   Efficiency   Median rate   Samples
      1       18.420 s     1.00x       100.0%      54.29/s        20
      2        9.730 s     1.89x        94.7%     102.77/s        20
      4        5.210 s     3.54x        88.4%     191.94/s        20
      8        3.280 s     5.62x        70.2%     304.88/s        20
```

Speedup and efficiency use the median one-thread runtime:

```text
S(N) = T(1) / T(N)
E(N) = S(N) / N × 100%
```

Set `minimum-efficiency` to a fraction such as `0.60` to fail report mode when efficiency at the largest tested
thread count falls below the threshold.

## CPU and runner discovery

ThreadScale uses Node's affinity-aware available-parallelism value, `nproc` when present, and Linux cgroup CPU
quotas. It takes the most restrictive detected value and applies `max-threads` last. Reports retain:

- visible and logical CPU counts;
- CPU model, architecture, operating system, and runner labels;
- Linux process affinity from `taskset`, when available;
- `lscpu` output, when available;
- the effective cgroup CPU quota, when present.

This metadata is important when comparing results across runner generations or self-hosted machines.

## Action modes

The root Action has three modes so custom workflows can use the same implementation as the reusable workflow:

- `discover` detects CPUs and emits `cores`, `thread-list`, `runner-metadata`, `job-count`, and a dynamic
  `matrix` for one of the three strategies.
- `benchmark` performs warmups and measured runs, then emits `result-file` and `results-dir`.
- `report` merges downloaded partials, emits final file paths, adds the Markdown report to the job summary, and
  applies the optional efficiency threshold.

Discover mode accepts a JSON `benchmarks` array. Every object requires `name` and `command`; optional fields are
`working_directory`, `workload`, and `workload_unit`.

## Benchmarking guidance

Ordinary GitHub-hosted runners are useful for checking whether threading works, catching catastrophic scaling
regressions, and locating obvious saturation. They are shared virtual machines and are not controlled HPC
benchmark nodes. Prefer replicated sweeps, medians, and a generous regression threshold. Use a stable,
self-hosted runner with pinned CPU frequency and no competing load for publication-quality measurements.

Keep the workload large enough that process startup and setup are a small fraction of runtime. Run identical
work at every thread count, avoid unrelated I/O where possible, and use warmup runs for applications with caches
or just-in-time compilation.

## Development and releases

ThreadScale has no runtime dependencies and does not need a bundled `node_modules` tree. Local checks require
Node.js 24:

```shell
npm run check
npm test
```

To publish in the GitHub Actions Marketplace, create a release whose tag also has a stable major alias such as
`v1`. Consumers should use the major tag or pin a full commit SHA when reproducibility or supply-chain policy
requires it. Publish the `v1` tag before consumers invoke the reusable workflow; its internal Action references
also use that stable major tag.

ThreadScale is available under the [MIT License](LICENSE).

[test-workflow]: https://github.com/gemc/ThreadScale/actions/workflows/test.yml
