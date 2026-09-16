import type { AfterInstallHook } from "@cheetos/core";

/** Indicate which installer was used so error messages stay actionable. */
type Installer = "uv" | "pipx" | "pip";

/**
 * True when `command -v` resolved the binary to a non-empty path on any shell
 * we are likely to run under. POSH, zsh, bash, ksh, dash all support
 * `command -v`; Windows cmd.exe does not.
 * @param run - Confined shell command helper.
 * @param command - Command name to look up.
 * @returns True when the command resolves on PATH.
 */
async function commandOnPath(
	run: (command: string) => Promise<string>,
	command: string,
): Promise<boolean> {
	const probes = [
		`command -v ${command}`,
		`which ${command}`,
		`type ${command}`,
	];
	for (const probe of probes) {
		try {
			const output = (await run(probe)).trim();
			if (output.length > 0) return true;
		} catch {
			// Try the next probe.
		}
	}
	return false;
}

/**
 * Pick the first available Python interpreter on PATH.
 * @param run - Confined shell command helper.
 * @returns Resolved python launcher command, or undefined when none is found.
 */
async function pickPythonLauncher(
	run: (command: string) => Promise<string>,
): Promise<string | undefined> {
	for (const launcher of ["python3", "python", "py"]) 
		if (await commandOnPath(run, launcher)) return launcher;
	return undefined;
}

/**
 * Pick the first installer available on the user's PATH in priority order.
 * @param run - Confined shell command helper.
 * @returns Detected installer, or undefined when none is available.
 */
async function pickInstaller(
	run: (command: string) => Promise<string>,
): Promise<Installer | undefined> {
	if (await commandOnPath(run, "uv")) return "uv";
	if (await commandOnPath(run, "pipx")) return "pipx";
	if (await pickPythonLauncher(run)) return "pip";
	return undefined;
}

/**
 * Build the install command for the chosen installer and detected Python launcher.
 * @param installer - Selected installer.
 * @param python - Resolved Python launcher (only used when installer is `pip`).
 * @returns Shell command that installs the Graphify CLI into an isolated location.
 */
function installCommand(installer: Installer, python: string): string {
	switch (installer) {
		case "uv":
			return "uv tool install graphifyy";
		case "pipx":
			return "pipx install graphifyy";
		case "pip":
			return `${python} -m pip install --user graphifyy`;
	}
}

/**
 * `afterInstall` hook that installs the Graphify CLI and registers the skill.
 *
 * Runs after the `graphify.mdc` rule has been written. Idempotent: skips work
 * when Graphify is already on PATH.
 * @param ctx - Install hook context with confined `run` helper.
 */
const installGraphifyCli: AfterInstallHook = async (ctx) => {
	if (await commandOnPath(ctx.run, "graphify")) return;

	const installer = await pickInstaller(ctx.run);
	if (!installer) {
		throw new Error(
			'Graphify requires one of "uv", "pipx", or "python" on PATH to install the CLI. ' +
				'Install one and re-run the agent-instruction install.',
		);
	}

	const python = installer === "pip" ? (await pickPythonLauncher(ctx.run)) ?? "python3" : "python3";
	await ctx.run(installCommand(installer, python));
	await ctx.run("graphify install");
};

export default installGraphifyCli;