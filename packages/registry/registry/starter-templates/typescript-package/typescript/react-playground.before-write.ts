import type { BeforeWriteHook } from "@pebbles/core";

/**
 * Point the react-app scaffold dependency at the package's playground folder.
 * The binding appends `/playground` to the react-app item's file targets and
 * project name, so the `playground` script resolves to `{{projectName}}/playground`.
 * @returns Binding that relocates the react-app scaffold into the package.
 */
const reactPlayground: BeforeWriteHook = async () => ({
	bindings: { appSubdir: "/playground" },
});

export default reactPlayground;