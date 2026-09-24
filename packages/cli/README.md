# recipebook

The published `recipebook` CLI package.

## Commands

### `add`

Install one registry item into the current working directory:

```bash
npx recipebook add pr-template-configuration
npx recipebook add testing-configuration --overwrite
npx recipebook add
```

`add` installs at most one item per invocation. When no item id is provided, `add` prompts with a grouped single-select. Shared registry conditions use local condition handlers for prompt defaults when available, then prompt for the rest. Compiled item files are fetched from the index location, item handlers may generate or transform files, and packages are installed using the project’s selected package manager (lockfile detection, otherwise a prompt) after confirming whether to install now.

## Registry source

No registry ships with `recipebook`. A command that needs a registry source resolves one explicitly, in this precedence order:

1. `--registry` CLI flag at each command:

```bash
npx recipebook --registry <url-or-path> add pr-template-configuration
```

2. `RECIPEBOOK_REGISTRY` environment variable:

```bash
export RECIPEBOOK_REGISTRY="<url-or-path>"
npx recipebook add pr-template-configuration
```

3. A source persisted with the `configure` command:

```bash
npx recipebook configure set <url-or-path>
npx recipebook configure get
npx recipebook configure unset
npx recipebook add pr-template-configuration
```

When no source is configured, an interactive `add` prompts you to set one via `configure set`; in a non-interactive shell it fails fast with remediation guidance instead of hanging.
