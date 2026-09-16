# Contributing

Thanks for your interest in contributing to `pebbles`! This guide will help you get started with the development process, from setting up your environment to submitting changes.

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

- Search existing [GitHub Discussions](https://github.com/agrawal-rohit/pebbles/discussions) first
- Open a new discussion for questions and proposals
- Create a [GitHub Issue](https://github.com/agrawal-rohit/pebbles/issues) for bug reports

Please be specific about your environment and include steps to reproduce issues when reporting bugs.

## Development Setup

1. Fork the repository
2. Install dependencies: `pnpm install`
3. Build the workspace: `pnpm run build`
4. Build the default registry: `pnpm run build:registry`
5. Test the CLI package locally: `pnpm --filter pebbles pack`

The repository is a pnpm workspace with the following structure:

- `packages/cli`: published as `pebbles`
- `packages/core`: published as `@pebbles/core`
- `packages/registry`: private default registry content
- `docs`: documentation site

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

Pre-commit hooks run lint-staged (Biome/typecheck/registry rebuild) and then `pnpm run quality:changes`. If they block your commit, fix the reported issues and try again.

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
   - create component tags (for example `pebbles@v0.3.0`, `core@v0.3.0`)
   - publish only the released packages to npm with trusted publishing

The workflow in [`.github/workflows/release.yml`](./.github/workflows/release.yml)
is package-agnostic: it runs release-please, then `pnpm -r publish`, which
skips private packages and versions already on the registry. To add or rename a
package, edit only [`release-please-config.json`](./release-please-config.json)
and [`.release-please-manifest.json`](./.release-please-manifest.json). For a
Python or Rust repo, keep the release-please job and swap the publish step.

**Note:** `pebbles` and `@pebbles/core` version independently.
`@pebbles/registry` is private, excluded from release-please, and never
published to npm. Because the CLI depends on core via `workspace:*`, releasing
core also patch-bumps the CLI so a core fix always ships in a new CLI release.

### Testing Pre-releases

Pre-release automation is intentionally deferred for now. Stable releases use
the Release PR flow above. If a pre-release is needed, cut it explicitly and
test it the same way you would test a stable publish:

```bash
# For pebbles itself
npx pebbles@1.2.3-rc.1 --help

# For @pebbles/core
npm install @pebbles/core@1.2.3-rc.1
```

Found a bug? Fix it on `main`, merge the change, and merge the next Release PR
when you are ready to publish the next version.

## Dependencies

- Propose new dependencies via GitHub Issues first
- Consider bundle size, maintenance burden, and licensing
- Security updates and critical fixes are always welcome
- Include rationale and testing notes for dependency changes

## Code Registry

`pebbles` uses a JSON registry inspired by [shadcn](https://ui.shadcn.com/docs/registry) to distribute all registry items _(e.g. starter templates, UI components, configurations, and agent instructions)_. Each unit is a self-contained folder holding its manifest and its source files. A unit can be wired to other items through the `registryDependencies` property to make composable units.

The default registry content lives under `packages/registry/registry/`. Shared registry conditions are centralized in `packages/registry/registry/conditions/conditions.json` (handlers colocated under `conditions/`). Item type display metadata is centralized in `packages/registry/registry/types.json`. Compilation is provided by `@pebbles/core` (`buildRegistry`); `@pebbles/registry` is content plus a short build script.

### Registry Layout

Every item is a folder under `packages/registry/registry/` containing a `registry-item.json` manifest alongside the files it ships. Folder paths are just for convenience, the manifest holds the actual identity.

```text
packages/registry/registry/
├── conditions/
│   ├── conditions.json
│   └── language.ts
├── types.json
├── configuration/dependency-updater/  # id: dependency-updater
├── configuration/build/               # id: build
├── configuration/changelog/           # id: changelog
├── component/button/                  # id: button
│   ├── registry-item.json
│   └── react/button.tsx
└── …
```

The compiled items are written next to the package root by `pnpm run build:registry` (`buildRegistry` from `@pebbles/core`):

- `packages/registry/registry.json` — lean index metadata (committed; regenerated and staged by the pre-commit hook)
- `packages/registry/r/{itemId}.json` or `packages/registry/r/{itemId}/{variantId}.json` — compiled items (gitignored; generated locally and copied into the CLI npm tarball at `prepack`)

`registry.json` is regenerated and staged automatically by the pre-commit hook whenever anything under `packages/registry/registry/` or the core compiler changes. Compiled item files under `r/` are build output only — not committed — and ship with the published `pebbles` package.

`registry.json` only holds index metadata for individual items, so the index stays lean as the registry grows. Source manifests keep item-relative file `source` paths, ecosystem-tagged `dependencies`, optional `beforeWrite` / `afterInstall` scripts, and variant descriptions. The build inlines those files into compact payloads under `r/`, bundles install scripts to `r/{itemId}.beforeWrite.{index}.js` and `r/{itemId}.afterInstall.{index}.js` (and pack scripts under `r/{itemId}/{packId}.…`, plus condition handlers to `r/_handlers/{key}.handler.js`), and writes a compact index entry keyed by item id. Payloads keep `target`, inlined `content`, and `dependencies` keyed by ecosystem — no item or variant identity fields. Consumers join index `source` values and script URIs against the index location. Third-party registries that host remotely should keep `registry.json` and `r/` side by side (GitHub raw, S3, or a CDN). The default registry ships payloads inside the CLI package instead.

Payload `content` is the source template text. Condition defaults and install lifecycle scripts run on the client after the payload is loaded — not at compile time. **Install scripts execute only for local registries** (bundled CLI registry, a local `--registry` path, or a third-party package). Remote HTTPS registries cannot execute custom scripts. Local registries run scripts without confirmation. Compiled `scriptIntegrity` / `itemIntegrity` digests are verified before load; hooks run in a sandboxed child process.

### Install scripts and condition handlers

Colocate a TypeScript install script next to the manifest (or under `registry/conditions/` for shared conditions). Use `import type` from `@pebbles/core` — do not runtime-import the package (the build rejects it).

```ts
import type { BeforeWriteHook } from "@pebbles/core";

const beforeWrite: BeforeWriteHook = async (ctx) => {
	const licenseId = ctx.conditions.licenseId;
	return {
		bindings: { customKey: String(licenseId) },
		files: [{ target: "LICENSE", content: String(licenseId) }],
	};
};

export default beforeWrite;
```

Point the manifest at it with `"beforeWrite": "render-license-file.before-write.ts"`. Script-only items may omit `files`. Compose other registry items with `"dependsOn"` — they install before this item. Shared conditions can declare `"handler": "conditions/language.handler.ts"` with an `infer` hook that returns a prompt default (for example from marker files or `ctx.run("git config --get user.name")`). Condition `kind` may be `select` (default), `multiselect`, `text`, or `boolean`. Items declare those dependencies with `"requires": ["authorName"]`; the captured value is then `ctx.conditions.authorName` in install scripts.

See `packages/registry/registry/configurations/license/` for an SPDX license picker that generates a `LICENSE` file during `beforeWrite`.

Third-party registries compile the same way — pass the registry source tree and output directory explicitly:

```ts
import { buildRegistry } from "@pebbles/core";

await buildRegistry({
	sourceDir: path.join(packageRoot, "registry"),
	outDir: packageRoot,
});
```

### Source guidelines

- Keep items atomic and colocate the manifest and every file it ships in one folder.
- Extract reusable concerns into their own items and reference them via `dependsOn`.
- Run `pnpm run build:registry` after changing items _(the pre-commit hook and `prepack` also run it)_.

### Proposing New Items

When proposing a new registry item:

1. Add a new folder under `packages/registry/registry/` with a `registry-item.json` (`id`, `title`, `description`, `type`, plus `files`, `variants`, and/or `handler`) and its files
2. Declare the item `type` in `packages/registry/registry/types.json` with a `label` and optional `description` _(required for every registry)_
3. Include everything needed for a complete working setup; depend on existing concern items instead of copying files
4. Run `pnpm run build:registry`, `pnpm cov`, and `pnpm --filter pebbles pack`
5. Document what the item provides in your pull request
6. Include examples of generated output

## Security

- **Do not** report security vulnerabilities in public issues
- Use GitHub's [private vulnerability reporting](https://github.com/agrawal-rohit/pebbles/security/advisories/new)

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
