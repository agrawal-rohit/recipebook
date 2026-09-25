import path from "node:path";
import { type BuildRegistryOptions, buildRegistry } from "recipebook-core";
import { dimText, primaryText } from "../cli/labels";

/** Overrides accepted from the CLI, mirroring core's option names. */
type BuildOverrides = Omit<BuildRegistryOptions, "sourceDir" | "outDir">;

/**
 * Compile a registry source directory into a compiled registry.
 * @param sourceDir - Path to the registry source tree (cwd-relative).
 * @param outDir - Path where compiled output is written (cwd-relative).
 * @param overrides - Optional file/directory name overrides for the build.
 */
export async function buildCommand(
	sourceDir: string,
	outDir: string,
	overrides: BuildOverrides,
): Promise<void> {
	const registry = await buildRegistry({ sourceDir, outDir, ...overrides });
	const itemCount = Object.keys(registry.items).length;
	const itemWord = itemCount === 1 ? "item" : "items";

	console.log();
	console.log(dimText(`Built ${itemCount} ${itemWord}.`));

	const registryFileName = (
		overrides.registryFileName ?? "registry.json"
	).trim();

	console.log(primaryText(`Output: ${path.resolve(outDir, registryFileName)}`));
}
