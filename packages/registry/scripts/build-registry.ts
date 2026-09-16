import path from "node:path";
import { buildRegistry } from "@cheetos/core";

/** Compile the registry registry source tree under this package (or `process.argv[2]`). */
async function main(): Promise<void> {
	const root = path.resolve(process.argv[2] ?? path.join(__dirname, ".."));
	const document = await buildRegistry({
		sourceDir: path.join(root, "registry"),
		outDir: root,
	});
	console.log(
		`Built ${Object.keys(document.items).length} items to registry.json.`,
	);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
