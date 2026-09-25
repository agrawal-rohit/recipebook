import type { Registry } from "@recipebook/core";
import cac, { type CAC } from "cac";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	type MockInstance,
	test,
	vi,
} from "vitest";
import { animatedIntro } from "../../cli/animated-intro";
import { buildCommand } from "../build";
import { registerCommandsCli } from "../index";

vi.mock("../build", () => ({ buildCommand: vi.fn(async () => {}) }));
vi.mock("../../cli/animated-intro", () => ({
	animatedIntro: vi.fn(async () => {}),
}));

const buildMock = vi.mocked(buildCommand);
const animatedIntroMock = vi.mocked(animatedIntro);

async function runBuildCli(args: string[]): Promise<void> {
	const app = cac("recipebook");
	registerCommandsCli(app, async () => {
		throw new Error("registry loader must not run for the build command");
	});
	await app.parse(["node", "recipebook", ...args]);
}

describe("build command wiring", () => {
	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		buildMock.mockClear();
		animatedIntroMock.mockClear();
		errorOutput = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput.push(args.map((arg) => String(arg)).join(" "));
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		// Record the requested exit without terminating the test process.
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined as never) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should dispatch buildCommand with the default sourceDir and outDir when no positionals or flags are given because a bare `recipebook build` compiles ./ into dist", async () => {
		await runBuildCli(["build"]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(buildMock).toHaveBeenCalledWith(".", "dist", {});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	test("it should dispatch buildCommand with the parsed positionals and every override flag because each flag must map to its core option", async () => {
		await runBuildCli([
			"build",
			"registry-src",
			"registry-dist",
			"--registry-file-name",
			"index.json",
			"--item-manifest-file-name",
			"manifest.json",
			"--types-file-name",
			"custom/types.json",
			"--conditions-file-name",
			"shared/conditions.json",
			"--compiled-dir-name",
			"compiled",
			// A single --external arrives from CAC as a string; the wiring must
			// normalize it to the string[] core expects.
			"--external",
			"lodash",
		]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(buildMock).toHaveBeenCalledWith("registry-src", "registry-dist", {
			registryFileName: "index.json",
			itemManifestFileName: "manifest.json",
			typesFileName: "custom/types.json",
			conditionsFileName: "shared/conditions.json",
			compiledDirName: "compiled",
			bundleExternalPackages: ["lodash"],
		});
	});

	test("it should collect repeated --external flags into one package list because the flag is repeatable", async () => {
		await runBuildCli(["build", "--external", "a", "--external", "b"]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(buildMock).toHaveBeenCalledWith(".", "dist", {
			bundleExternalPackages: ["a", "b"],
		});
	});

	test("it should print an error and exit 1 without dispatching when tokens trail the two positionals because build takes at most a source directory and an output directory and one package per --external flag", async () => {
		await runBuildCli(["build", "--external", "chalk", "lodash", "src", "out"]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			"build takes at most a source directory and an output directory; pass one package per --external flag.",
		);
		expect(buildMock).not.toHaveBeenCalled();
	});

	test('it should print an error and exit 1 without dispatching when tokens follow a bare -- because CAC hides them in options["--"] and silently dropping them would build the wrong directories', async () => {
		await runBuildCli(["build", "--", "/tmp/other-src", "/tmp/intended-out"]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			'build does not accept arguments after "--"; pass the source and output directories as regular positional arguments.',
		);
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 without dispatching when tokens follow -- after other flags because post--- tokens are never bound to positionals and must not be silently dropped", async () => {
		await runBuildCli([
			"build",
			"--external",
			"a",
			"--",
			"registry-src",
			"registry-out",
		]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain(
			'build does not accept arguments after "--"; pass the source and output directories as regular positional arguments.',
		);
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 without dispatching when a repeated --external ends without a value because the trailing valueless flag arrives as `true` inside the package list and must demand a value", async () => {
		await runBuildCli(["build", "--external", "a", "--external"]);

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("--external requires a value");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should introduce the build flow with the building intro title because the intro copy is part of the command's user-facing surface", async () => {
		await runBuildCli(["build"]);

		await vi.waitFor(() => expect(buildMock).toHaveBeenCalledTimes(1));
		expect(animatedIntroMock).toHaveBeenCalledWith("building the registry");
	});

	test("it should fail fast when --external is given without a value because CAC rejects a valueless required option before any dispatch", async () => {
		await expect(runBuildCli(["build", "--external"])).rejects.toThrow(
			"value is missing",
		);
		expect(buildMock).not.toHaveBeenCalled();
	});
});

describe("build command argument guards against parser contract drift", () => {
	// cac coerces positionals and `--flag=x` to strings, so these guards cannot
	// fire through a real parse. Driving the registered build action directly
	// through a duck-typed CAC double pins the fail-fast contract the guards
	// promise if the parser's behavior ever changes.
	interface FakeCommand {
		option: ReturnType<typeof vi.fn>;
		usage: ReturnType<typeof vi.fn>;
		action: ReturnType<typeof vi.fn>;
	}

	function fakeCacApp(): {
		app: CAC;
		buildAction: (
			sourceDir: unknown,
			outDir: unknown,
			options: unknown,
		) => Promise<void>;
		optionCalls: [string, string][];
	} {
		const command: FakeCommand = {
			option: vi.fn(),
			usage: vi.fn(),
			action: vi.fn(),
		};
		const commandNames: string[] = [];
		const app = {
			command: vi.fn((name: string) => {
				commandNames.push(name);
				return command;
			}),
			args: [] as unknown[],
			parse: vi.fn(async () => {}),
		};
		registerCommandsCli(
			app as unknown as CAC,
			vi.fn(async () => ({
				registry: {} as Registry,
				indexLocation: "/fake",
			})),
		);
		const buildIndex = commandNames.findIndex((name) =>
			name.startsWith("build"),
		);
		if (buildIndex === -1) throw new Error("build command is not registered.");
		const buildAction = command.action.mock.calls[buildIndex]?.[0] as (
			sourceDir: unknown,
			outDir: unknown,
			options: unknown,
		) => Promise<void>;
		return {
			app: app as unknown as CAC,
			buildAction,
			optionCalls: command.option.mock.calls as [string, string][],
		};
	}

	let errorOutput: string[];
	let exitSpy: MockInstance<typeof process.exit>;

	beforeEach(() => {
		buildMock.mockClear();
		errorOutput = [];
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorOutput.push(args.map((arg) => String(arg)).join(" "));
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined as never) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("it should declare --external as one value per flag because CAC does not implement variadic options and the declaration must not advertise a form it cannot parse", () => {
		const { optionCalls } = fakeCacApp();

		const externalDecl = optionCalls.find(([name]) =>
			name.startsWith("--external"),
		);
		expect(externalDecl?.[0]).toBe("--external <package>");
	});

	test("it should print an error and exit 1 when the sourceDir positional is not a string because a parser that stops coercing positionals must hit a fail-fast guard, not a corrupt build", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(123, "dist", {});

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("must be a string");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 when a build flag value is not a string because a mis-typed option must fail loudly instead of building with a surprise value", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(".", "dist", { registryFileName: 42 });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("must be a string");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 when a build flag arrives as `true` because a valueless flag must demand a value instead of silently building with a default", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(".", "dist", { typesFileName: true });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("requires a value");
		expect(buildMock).not.toHaveBeenCalled();
	});

	test("it should print an error and exit 1 when --external arrives as `true` because a valueless repeatable flag must fail fast instead of passing a non-list to core", async () => {
		const { buildAction } = fakeCacApp();

		await buildAction(".", "dist", { external: true });

		await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
		expect(errorOutput.join("\n")).toContain("requires a value");
		expect(buildMock).not.toHaveBeenCalled();
	});
});
