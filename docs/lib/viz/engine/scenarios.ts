/**
 * Named teaching scenarios — biased toward complex graphs, hooks, and packs.
 */

import type { RegistryContext, RegistryPackageManager } from "./simulate";
import { NpmPackageManager } from "./simulate";

export interface Scenario {
  id: string;
  label: string;
  description: string;
  selectedItems: string[];
  context: RegistryContext;
  packageManager?: RegistryPackageManager;
  /** Extra seed files beyond the default project skeleton. */
  seedFs?: Record<string, string>;
}

const baseTsContext: RegistryContext = {
  language: "typescript",
  defaultBranch: "main",
  authorName: "Ada Lovelace",
  githubUsername: "ada",
  projectName: "@ada/demo-pkg",
  codingAgentIDE: "cursor",
};

/** Built-in walkthroughs ordered from mid → deep complexity. */
export const scenarios: readonly Scenario[] = [
  {
    id: "quality-multi",
    label: "Quality packs + afterInstall",
    description:
      "code-quality-workflow with biome + fallow packs, shared requires, and a fallow afterInstall script.",
    selectedItems: ["code-quality-workflow"],
    context: {
      language: "typescript",
      defaultBranch: "main",
      qualityTools: ["biome", "fallow"],
    },
    packageManager: NpmPackageManager.PNPM,
  },
  {
    id: "testing-deep",
    label: "Testing deep graph",
    description:
      "testing-configuration pulls workspace setup, package management, and both test-quality agent + subagent (beforeWrite chain).",
    selectedItems: ["testing-configuration"],
    context: { ...baseTsContext },
    packageManager: NpmPackageManager.PNPM,
  },
  {
    id: "multi-root",
    label: "Multi-root selection",
    description:
      "Three roots at once: release workflow, security checks, and license — overlapping deps + mixed hooks.",
    selectedItems: [
      "release-package-workflow",
      "security-checks-workflow",
      "license-configuration",
    ],
    context: {
      ...baseTsContext,
      licenseId: "Apache-2.0",
      copyrightYear: "2026",
    },
    packageManager: NpmPackageManager.PNPM,
    seedFs: {
      LICENSE: "OLD LICENSE — will conflict\n",
    },
  },
  {
    id: "starter-basic",
    label: "TypeScript package starter",
    description:
      "Full typescript-package-starter-template (basic pack) — largest dependsOn fan-out in the registry.",
    selectedItems: ["typescript-package-starter-template"],
    context: {
      ...baseTsContext,
      packageKind: "basic",
      publishToNpm: true,
      initializeGit: true,
      licenseId: "MIT",
      copyrightYear: "2026",
      enforcementContact: "ada@example.com",
      nodeVersion: "22",
      qualityTools: ["biome"],
    },
    packageManager: NpmPackageManager.PNPM,
  },
  {
    id: "starter-react",
    label: "React library starter",
    description:
      "Same starter with packageKind=react — adds react agent + app template via pack dependsOn and beforeWrite.",
    selectedItems: ["typescript-package-starter-template"],
    context: {
      ...baseTsContext,
      packageKind: "react",
      publishToNpm: true,
      initializeGit: true,
      licenseId: "MIT",
      copyrightYear: "2026",
      enforcementContact: "ada@example.com",
      nodeVersion: "22",
      qualityTools: ["biome", "sonar"],
      sonarProjectKey: "ada_demo",
      sonarOrganization: "ada",
    },
    packageManager: NpmPackageManager.PNPM,
  },
  {
    id: "leaf",
    label: "Leaf (contrast)",
    description: "Tiny leaf item — useful contrast against the deep graphs.",
    selectedItems: ["pr-template-configuration"],
    context: {},
  },
];

/**
 * Look up a scenario by id.
 * @param id - Scenario id
 */
export function scenarioById(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
