import type { BeforeWriteHook, HandlerRuntime } from "@cheetos/core";

/** Workflow file paths paired with the check contexts they emit. */
const WORKFLOW_CHECK_MAP: Array<{ workflowPath: string; checks: string[] }> = [
	{
		workflowPath: ".github/workflows/build.yml",
		checks: ["Build"],
	},
	{
		workflowPath: ".github/workflows/test.yml",
		checks: ["Test (Coverage)"],
	},
	{
		workflowPath: ".github/workflows/quality-biome.yml",
		checks: ["Code Quality (Biome)"],
	},
	{
		workflowPath: ".github/workflows/quality-sonar.yml",
		checks: ["Code Quality (SonarQube)"],
	},
	{
		workflowPath: ".github/workflows/quality-fallow.yml",
		checks: ["Code Quality (Fallow)"],
	},
	{
		workflowPath: ".github/workflows/security.yml",
		checks: [
			"Workflow Security (Zizmor)",
			"Code Security (CodeQL)",
			"Code Security (Semgrep)",
			"Code Security (Dependency Review)",
		],
	},
];

interface RulesetRule {
	type: string;
	parameters?: {
		strict_required_status_checks_policy?: boolean;
		do_not_enforce_on_create?: boolean;
		required_status_checks?: Array<{ context: string }>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface RulesetDocument {
	rules?: RulesetRule[];
	[key: string]: unknown;
}

/**
 * Collect all active status check contexts from workflows present in the project.
 * @param ctx - Handler runtime.
 * @returns Set of check contexts.
 */
async function collectActiveChecks(
	ctx: HandlerRuntime,
): Promise<Set<string>> {
	const active = new Set<string>();
	for (const { workflowPath, checks } of WORKFLOW_CHECK_MAP) {
		if (await ctx.isFile(workflowPath)) {
			for (const check of checks) active.add(check);
		}
	}
	return active;
}

/**
 * Filter rules array by active checks.
 * @param rules - Rules from ruleset document.
 * @param activeChecks - Active check names.
 * @returns Filtered/updated rules.
 */
function updateRulesWithChecks(
	rules: RulesetRule[],
	activeChecks: Set<string>,
): RulesetRule[] {
	if (activeChecks.size === 0) {
		return rules.filter((rule) => rule.type !== "required_status_checks");
	}
	for (const rule of rules) {
		if (rule.type === "required_status_checks" && rule.parameters) {
			rule.parameters.required_status_checks = [...activeChecks].map(
				(context) => ({ context }),
			);
		}
	}
	return rules;
}

/**
 * Filter the `required_status_checks` array in `.github/rulesets/protected-branches.json`
 * down to only the check contexts emitted by workflows actually installed in the
 * project. Removes the entire rule when no workflows are installed. Prevents
 * blocking PR merges on checks that never run.
 * @param ctx - Install hook context.
 * @returns Updated protected-branches.json file.
 */
const filterActiveWorkflowChecks: BeforeWriteHook = async (ctx) => {
	const activeChecks = await collectActiveChecks(ctx);

	const rulesetTarget = ".github/rulesets/protected-branches.json";
	const currentFile = ctx.compiledItem.files.find(
		(file) => file.target === rulesetTarget,
	);
	if (!currentFile) return undefined;

	try {
		const document = JSON.parse(currentFile.content) as RulesetDocument;
		if (Array.isArray(document.rules)) {
			document.rules = updateRulesWithChecks(document.rules, activeChecks);
		}

		return {
			files: [
				{
					target: rulesetTarget,
					content: `${JSON.stringify(document, null, "\t")}\n`,
				},
			],
		};
	} catch {
		return undefined;
	}
};

export default filterActiveWorkflowChecks;
