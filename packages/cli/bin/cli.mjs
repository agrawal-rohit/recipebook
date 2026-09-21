#!/usr/bin/env node
import indexModule from "../dist/index.js";

const run = indexModule.default;
const printError = indexModule.printError;

try {
	await run();
} catch (err) {
	printError(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
}
