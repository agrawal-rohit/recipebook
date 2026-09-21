# Contributing

Thanks for your interest in contributing to `cheetos`! This guide will help you get started with the development process, from setting up your environment to submitting changes.

## Table of Contents

- [Getting Help](#getting-help)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing & Code Quality](#testing--code-quality)
- [Documentation](#documentation)
- [Release Process](#release-process)
- [Dependencies](#dependencies)
- [Code Registry](#code-registry)
- [Security](#security)
- [Maintainer Guidelines](#maintainer-guidelines)
- [Recognition](#recognition)

## Getting Help

If you have questions, ideas, or need help:

- Search existing [GitHub Discussions](https://github.com/agrawal-rohit/cheetos/discussions) first
- Open a new discussion for questions and proposals
- Create a [GitHub Issue](https://github.com/agrawal-rohit/cheetos/issues) for bug reports

Please be specific about your environment and include steps to reproduce issues when reporting bugs.

## Development Setup

1. Fork the repository
2. Install dependencies: `pnpm install`
3. Build the workspace: `pnpm run build`
4. Test the CLI package locally: `pnpm --filter cheetos pack`

The repository is a pnpm workspace with the following structure:

- `packages/cli`: published as `cheetos`
- `packages/core`: published as `@cheetos/core`

## Making Changes

### Branching Strategy

- Create feature branches from `main`
- Use descriptive branch names: `feat/<scope>-description` or `fix/<scope>-description`
- Keep changes focused and atomic

### Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```text
type(scope): short description

Optional longer description

BREAKING CHANGE: details (if applicable)
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`

### Pull Requests

- Run `pnpm run check` and `pnpm cov` before opening a pull request
- Include tests for new features and bug fixes
- Use a conventional commit type that reflects the change impact
- Reference related issues using GitHub keywords (e.g., `Closes #123`)
- Use a clear title and explain the why behind changes
- Keep PRs focused on a single purpose

## Testing & Code Quality

- Typecheck and lint: `pnpm run check`
- Build packages: `pnpm run build`
- Run tests with coverage: `pnpm cov`
- Quality gate on changed files: `pnpm run quality:changes`
- Full codebase quality scan: `pnpm run quality` (or `pnpm run quality dead-code`, `pnpm run quality health`, etc.)
- Format code: `pnpm run format`

Pre-commit hooks run lint-staged (Biome/typecheck) and then `pnpm run quality:changes`. If they block your commit, fix the reported issues and try again.

## Documentation

- Update `README.md` or [`docs/`](./docs) for public-facing changes
- Document new APIs, CLI commands, and configuration options
- Include examples for complex functionality
- Keep documentation consistent with code changes

Small documentation fixes (typos, clarifications) are always welcome!

## Release Process

### Overview

> [!IMPORTANT]
>
> - [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) must be configured
> - `GH_ADMIN_TOKEN` must be added to the repository secrets and able to open pull requests that trigger CI and create protected release tags

This repository uses [release-please](https://github.com/googleapis/release-please)
for the release workflow.

### For contributors

1. Follow [Conventional Commits](https://www.conventionalcommits.org/)
2. Choose the commit type that matches the intended release impact:
   - `fix` / `perf` -> patch
   - `feat` -> minor
   - `!` or `BREAKING CHANGE:` -> major
3. Merge the pull request when the code is ready

Only packages whose files changed are versioned; commits under a package path
drive that package's bump.

To force a specific next version for a package, include a `Release-As: x.y.z`
footer in a commit message on `main`.

### For maintainers

Every push to `main` runs the `Release` workflow:

1. [release-please](https://github.com/googleapis/release-please) opens or
   updates a single Release PR with version bumps and changelogs for whichever
   packages have releasable changes
2. Review the Release PR (CI must pass; one approval is required)
3. Squash-merge the Release PR to:
   - bump only the packages that changed
   - create component tags (for example `cheetos@v0.3.0`, `core@v0.3.0`)
   - publish only the released packages to npm with trusted publishing

The workflow in [`.github/workflows/release.yml`](./.github/workflows/release.yml)
is package-agnostic: it runs release-please, then `pnpm -r publish`, which
skips private packages and versions already on the registry. To add or rename a
package, edit only [`release-please-config.json`](./release-please-config.json)
and [`.release-please-manifest.json`](./.release-please-manifest.json). For a
Python or Rust repo, keep the release-please job and swap the publish step.

**Note:** `cheetos` and `@cheetos/core` version independently. Because the CLI depends on core via `workspace:*`, releasing core also patch-bumps the CLI so a core fix always ships in a new CLI release.

### Testing Pre-releases

Pre-release automation is intentionally deferred for now. Stable releases use
the Release PR flow above. If a pre-release is needed, cut it explicitly and
test it the same way you would test a stable publish:

```bash
# For cheetos itself
npx cheetos@1.2.3-rc.1 --help

# For @cheetos/core
npm install @cheetos/core@1.2.3-rc.1
```

Found a bug? Fix it on `main`, merge the change, and merge the next Release PR
when you are ready to publish the next version.

## Dependencies

- Propose new dependencies via GitHub Issues first
- Consider bundle size, maintenance burden, and licensing
- Security updates and critical fixes are always welcome
- Include rationale and testing notes for dependency changes

## Code Registry

`cheetos` consumes code registries — JSON indexes of reusable setup items _(starter templates, UI components, configurations, agent instructions)_. Registries are authored and hosted outside this repository. A registry source is an HTTPS URL or a local file path to a compiled index, and the CLI resolves it via `--registry`, the `CHEETOS_REGISTRY` environment variable, or a saved source persisted with `cheetos configure set`. No registry ships in the box.

## Security

- **Do not** report security vulnerabilities in public issues
- Use GitHub's [private vulnerability reporting](https://github.com/agrawal-rohit/cheetos/security/advisories/new)

## Maintainer Guidelines

Some guidelines for maintainers:

- Changes to `main` should be added through pull requests
- Prefer merging the release-please Release PR over ad-hoc local tagging or publishing
- Keep required checks and branch protection enabled on `main` branch
- Avoid modifying config files in the repository without discussion:
  - Configuration files (`biome.json`, `release-please-config.json`, etc.)
  - CI workflows (`.github/workflows/*`)
  - Release tooling

If changes to these areas are needed, open an issue to discuss first.

## Recognition

Contributors are recognized through:

- GitHub's contributor graph
- Release notes (generated from conventional commits by release-please)
- Community acknowledgments

Your contributions are greatly appreciated!
