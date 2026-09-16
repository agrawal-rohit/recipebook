# cheetos

The published `cheetos` CLI package.

## Commands

### `add`

Install one registry item into the current working directory:

```bash
npx cheetos add pr-template-configuration
npx cheetos add testing-configuration --overwrite
npx cheetos add
```

`add` installs at most one item per invocation. When no item id is provided, `add` prompts with a grouped single-select. Shared registry conditions use local condition handlers for prompt defaults when available, then prompt for the rest. Compiled item files are fetched from the index location, item handlers may generate or transform files, and packages are installed using the project’s selected package manager (lockfile detection, otherwise a prompt) after confirming whether to install now.

## Registry source

By default, `cheetos` uses the bundled registry from the monorepo. You can point it at a custom registry in following ways:

1. CLI flag at each command:

```bash
npx cheetos --registry <url-or-path> add pr-template-configuration
```

2. Environment variable:

```bash
export CHEETOS_REGISTRY="<url-or-path>"
npx cheetos add pr-template-configuration
```

3. Global preference set through the `config` command:

```bash
npx cheetos config set <url-or-path>
npx cheetos config get
npx cheetos config unset
npx cheetos add pr-template-configuration
```