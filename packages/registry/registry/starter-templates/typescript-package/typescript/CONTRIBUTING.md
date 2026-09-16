# Contributing

Thanks for your interest in contributing to `{{projectName}}`! This guide will help you get started with the development process, from setting up your environment to submitting changes.

## Table of Contents

- [Getting Help](#getting-help)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Testing & Code Quality](#testing--code-quality)
- [Documentation](#documentation)
- [Release Process](#release-process)
- [Dependencies](#dependencies)
- [Security](#security)
- [Maintainer Guidelines](#maintainer-guidelines)
- [Recognition](#recognition)

## Getting Help

If you have questions, ideas, or need help:

- Search existing [GitHub Discussions](https://github.com/{{githubUsername}}/{{projectName}}/discussions) first
- Open a new discussion for questions and proposals
- Create a [GitHub Issue](https://github.com/{{githubUsername}}/{{projectName}}/issues) for bug reports

Please be specific about your environment and include steps to reproduce issues when reporting bugs.

## Development Setup

- Fork the repository
- Install dependencies: `{{packageManager}} install`
- Start development (watch): `{{pmRun}} dev`
{{#hasPlayground}}
- Start the playground: `{{pmRun}} playground`
{{/hasPlayground}}
- Run the test suite: `{{pmRun}} test`
- Build the library: `{{pmRun}} build`

## Making Changes

### Branching Strategy

- Create feature branches from `{{defaultBranch}}`
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

- Run tests with coverage: `{{pmRun}} cov`
- Include tests for new features and bug fixes
- Reference related issues using GitHub keywords (e.g., `Closes #123`)
- Use a clear title and explain the why behind changes
- Keep PRs focused on a single purpose

## Testing & Code Quality

- Run tests with coverage: `{{pmRun}} cov`
- Run type checks: `{{pmRun}} typecheck`

Pre-commit hooks will automatically check your code quality. If they block your commit, run the appropriate fix commands and try again.

## Documentation

- Update `README.md` for public-facing changes
- Document new APIs and configuration options
- Include examples for complex functionality
- Keep documentation consistent with code changes

Small documentation fixes (typos, clarifications) are always welcome!

## Release Process

### Overview

> [!IMPORTANT]
>
> - [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) must be configured
> - `GH_ADMIN_TOKEN` must be added to the repository secrets and able to open pull requests that trigger CI and create protected release tags

This project uses [release-please](https://github.com/googleapis/release-please) for the release workflow.

### For contributors

1. Follow [Conventional Commits](https://www.conventionalcommits.org/)
2. Choose the commit type that matches the intended release impact:
   - `fix` / `perf` -> patch
   - `feat` -> minor
   - `!` or `BREAKING CHANGE:` -> major
3. Merge the pull request when the code is ready

To force a specific next version, include a `Release-As: x.y.z` footer in a commit message on `{{defaultBranch}}`.

### For maintainers

Every push to `{{defaultBranch}}` runs the Release workflow:

1. [release-please](https://github.com/googleapis/release-please) opens or updates a Release PR with the version bump and changelog
2. Review the Release PR (CI must pass)
3. Squash-merge the Release PR to bump the version, create the release tag, and publish to npm with trusted publishing

## Dependencies

- Propose new dependencies via GitHub Issues first
- Consider bundle size, maintenance burden, and licensing
- Security updates and critical fixes are always welcome
- Include rationale and testing notes for dependency changes

## Security

- **Do not** report security vulnerabilities in public issues
- Use GitHub's [private vulnerability reporting](https://github.com/{{githubUsername}}/{{projectName}}/security/advisories)

## Maintainer Guidelines

- Changes to `{{defaultBranch}}` should be added through pull requests
- Keep required checks and branch protection enabled on the `{{defaultBranch}}` branch
- Avoid modifying CI workflows and release config without discussion

If changes to these areas are needed, open an issue to discuss first.

## Recognition

Contributors are recognized through:

- GitHub's contributor graph
- Release notes (generated from commit messages)
- Community acknowledgments

Your contributions are greatly appreciated!
