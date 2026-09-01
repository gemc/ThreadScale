# Contributing to ThreadScale

ThreadScale is free and open, and contributions are welcome. Useful contributions include source code,
documentation, examples, tests, bug reports, and reproducible scaling problems. We are happy to develop it
together — a pull request is the way to go.

Keep changes focused and reviewable. A small pull request with clear motivation is easier to review and safer
to merge than a broad rewrite.

## Before You Start

Open an issue before working on large changes, new features, public inputs and outputs, or behavior that
affects the reusable workflow, examples, and documentation. Small typo fixes, narrow documentation edits, and
obvious bug fixes can go directly to a pull request.

## Development Setup

Fork `gemc/ThreadScale` on GitHub, then clone your fork:

```shell
git clone https://github.com/<your-username>/ThreadScale.git
cd ThreadScale
```

ThreadScale has no runtime dependencies and does not need a bundled `node_modules` tree. Local checks require
Node.js 24 or newer.

## Build and Test

Run the local checks and the test suite:

```shell
npm run check
npm test
```

When a change touches shared code, run the smallest useful set of related tests plus any example that
exercises the behavior. If a test cannot be run locally, say why in the pull request.

## Contribution Guidelines

- Match the style of the surrounding code.
- Prefer clear, local fixes over broad refactors.
- Add or update tests for behavior changes.
- Update the README, examples, and release notes when user-facing behavior changes.
- Keep generated files, build output, caches, and local IDE files out of commits.
- Do not mix unrelated cleanup with feature or bug-fix work.

## Commit Messages

Use short, imperative commit summaries:

```text
Fix speedup calculation for replicated sweeps
```

When the reasoning is not obvious, add a body explaining what changed and why. If the pull request closes an
issue, include `Closes #123` in the pull request description.

## Pull Requests

Open a pull request from your fork to `gemc/ThreadScale`.

Before requesting review, check that:

- The title and description explain the change.
- Related issues are linked.
- Relevant tests or examples were run and listed.
- Documentation was updated if needed.
- The pull request is focused on one topic.

Reviews may ask for changes to improve correctness, maintainability, performance, documentation, or test
coverage.

## Communication

- General questions: open an issue.
- Direct contact: email **ungaro@jlab.org**.

## Licensing

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
