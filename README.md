<div align="center">
  <img src="https://cdn.rohit-agrawal.com/work/recipebook/logo.png" alt="Recipebook" style="width: 30%; margin: auto" />
</div>

<br />

<div align="center">
  <p align="center" style="width: 80%; margin: auto">
    <img alt="Status" src="https://img.shields.io/github/actions/workflow/status/agrawal-rohit/recipebook/ci.yml">
    <img alt="Coverage" src="https://img.shields.io/sonar/coverage/agrawal-rohit_recipebook?server=https%3A%2F%2Fsonarcloud.io">
    <img alt="Downloads" src="https://img.shields.io/npm/dt/recipebook">
    <img alt="Biome" src="https://img.shields.io/badge/code_style-biome-60a5fa">
    <img alt="License" src="https://img.shields.io/github/license/agrawal-rohit/recipebook" />
  </p>
</div>

<div align="center">
  <p>An opinionated scaffolding CLI that consumes recipebook code registries.</p>
</div>

`recipebook` eliminates repetitive project setup by providing opinionated templates with pre-configured tooling, best practices, and reusable registry items. It ships with two complementary packages:

- **`recipebook`**: the CLI users run via `npx` to scaffold projects and add components
- **`recipebook-core`**: shared internals and registry-document validation

No registry ships in the box — you must point the CLI at a registry source explicitly with the `--registry` flag, the `RECIPEBOOK_REGISTRY` environment variable, or a saved source persisted with `recipebook configure set`.

## Quickstart

Add a registry item to the current project (one at a time):

```bash
npx recipebook add pr-template-configuration
npx recipebook add testing-configuration --overwrite
npx recipebook add
```

Use a custom registry for one invocation:

```bash
npx recipebook --registry https://example.com/registry.json add pr-template-configuration
```

Persist a registry source (stored in `~/.config/recipebook/config.json`):

```bash
npx recipebook configure set https://example.com/registry.json
npx recipebook add pr-template-configuration
```

Inspect or clear the saved source:

```bash
npx recipebook configure get
npx recipebook configure unset
```

Or set it as an environment variable for all commands:

```bash
export RECIPEBOOK_REGISTRY="https://example.com/registry.json"
npx recipebook add pr-template-configuration
```

Registry source precedence: `--registry` flag > `RECIPEBOOK_REGISTRY` env > saved config. If a command needs a source and none is configured, interactive `npx recipebook add` prompts you to add one; in scripts (non-TTY) it fails fast with remediation guidance.
## Workspace layout

```text
packages/
├── cli/        # published as `recipebook`
└── core/       # published as `recipebook-core`
docs/           # documentation site
```

## Consuming registries

`recipebook-core` validates, parses, and plans installs from registry documents, and provides `buildRegistry` so third-party authors can compile a registry source tree into a compliant index. Registries are authored and hosted outside this repository; a registry source is an HTTPS URL or a local file path to a compiled index.

`recipebook-core` exposes:

- Schema types and validation for the index (`IndexItem`) and compiled items (`CompiledItem`)
- `parseRegistryDocument()` and `parseWithSchema()` for runtime validation (unknown keys are rejected; use `compiledItemSchema` for compiled items)
- `joinIndexSource()` for storage-agnostic index `source` joining

## Development

Requirements:

- Node.js 20+
- pnpm

Get started:

```bash
pnpm install
pnpm run build
```

Common development commands:

```bash
pnpm run check          # typecheck and lint (writes fixes)
pnpm run build          # build all packages
pnpm cov                # run tests with coverage
pnpm run quality:changes # quality gate on changed files (pre-PR)
pnpm run quality         # full codebase quality scan
```

## Releases

This repository uses [release-please](https://github.com/googleapis/release-please):

1. Contributors merge code using conventional commits
2. Every push to `main` opens or updates a Release PR with version bumps and changelog
3. Maintainers review and squash-merge the Release PR to tag changed packages
   (for example `recipebook@v0.3.0`, `core@v0.3.0`) and publish only those packages to npm

For details on the contributor and maintainer workflows, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © [Rohit Agrawal](https://rohit.build/)
