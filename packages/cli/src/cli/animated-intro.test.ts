import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { animatedIntro, createFixedHeightRenderer } from "./animated-intro";
import { InterruptError } from "./errors";

vi.mock("node:readline", () => ({
	default: {
		createInterface: vi.fn(() => ({ close: vi.fn() })),
		emitKeypressEvents: vi.fn(),
	},
	createInterface: vi.fn(() => ({ close: vi.fn() })),
	emitKeypressEvents: vi.fn(),
}));

vi.mock("chalk", () => ({
	default: {
		bold: vi.fn((text: string) => text),
		hex: vi.fn(() => vi.fn((text: string) => text)),
	},
}));

import readline from "node:readline";

describe("cli/animated-intro", () => {
	type MockStdout = {
		write: ReturnType<typeof vi.fn>;
		columns?: number;
		isTTY?: boolean;
	};

	type MockStdin = {
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
		setRawMode: ReturnType<typeof vi.fn>;
		isTTY: boolean;
	};

	let mockStdout: MockStdout;
	let mockStdin: MockStdin;

	beforeEach(() => {
		vi.clearAllMocks();
		mockStdout = {
			write: vi.fn(),
			columns: 80,
			isTTY: true,
		};
		mockStdin = {
			on: vi.fn(),
			off: vi.fn(),
			setRawMode: vi.fn(),
			isTTY: true,
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("animates a string message on a TTY stdout", async () => {
		await animatedIntro("Hello World", {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
			stdin: mockStdin as unknown as NodeJS.ReadStream,
			frameDelayMs: 1,
		});

		expect(mockStdout.write).toHaveBeenCalled();
		expect(readline.createInterface).toHaveBeenCalled();
		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(output).toContain("◔");
		expect((output.match(/●/g) ?? []).length).toBeGreaterThan(1);
		expect((output.match(/[●◔◕◑◒◓◐○]/g) ?? []).length).toBeGreaterThan(1);
		expect(stripVTControlCharacters(output)).toContain("Hello World");
		expect(stripVTControlCharacters(output)).not.toContain("HelloWorld");
		expect(output).not.toContain("Stryker was here!");
		expect(
			mockStdout.write.mock.calls.some((call) => call[0] === "Hello"),
		).toBe(true);
	});

	test("prints once without escape codes when stdout is not a TTY", async () => {
		mockStdout.isTTY = false;

		await animatedIntro("hello world", {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
			stdin: mockStdin as unknown as NodeJS.ReadStream,
		});

		expect(readline.createInterface).not.toHaveBeenCalled();
		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(output.includes("\u001b")).toBe(false);
		expect(output).toContain("yoinker");
		expect(output).toContain("hello world");
		expect(output).not.toContain("hello  world");
	});

	test("collapses consecutive spaces in non-TTY output", async () => {
		mockStdout.isTTY = false;

		await animatedIntro("hello  world", {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(output).toContain("hello world");
		expect(output).not.toContain("hello  world");
	});

	test("keeps messages that fill the column width", async () => {
		mockStdout.isTTY = false;
		mockStdout.columns = 50;
		const message = "a".repeat(50);

		await animatedIntro(message, {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		const msgLine = stripVTControlCharacters(output).split("\n")[2];
		expect(msgLine).toBe(message);
		expect(msgLine).not.toContain("...");
	});

	test("truncates long messages in non-TTY output", async () => {
		mockStdout.isTTY = false;
		mockStdout.columns = 50;
		const message = "a".repeat(51);

		await animatedIntro(message, {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		const msgLine = stripVTControlCharacters(output).split("\n")[2];
		expect(msgLine).toBe(`${"a".repeat(47)}...`);
	});

	test("uses a custom title when provided", async () => {
		mockStdout.isTTY = false;

		await animatedIntro("Test", {
			title: "Custom Title",
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(output).toContain("Custom Title");
	});

	test("restores raw mode and closes readline after animation", async () => {
		await animatedIntro("Test", {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
			stdin: mockStdin as unknown as NodeJS.ReadStream,
			frameDelayMs: 1,
		});

		expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
		expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
		expect(mockStdin.off).toHaveBeenCalledWith(
			"keypress",
			expect.any(Function),
		);
		const rlInterface = vi.mocked(readline.createInterface).mock.results[0]
			?.value as { close: ReturnType<typeof vi.fn> };
		expect(rlInterface.close).toHaveBeenCalled();
	});

	test("does not enable raw mode when stdin is not a TTY", async () => {
		mockStdin.isTTY = false;

		await animatedIntro("Test", {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
			stdin: mockStdin as unknown as NodeJS.ReadStream,
			frameDelayMs: 1,
		});

		expect(mockStdin.setRawMode).not.toHaveBeenCalled();
	});

	test("Escape aborts the animation without throwing", async () => {
		vi.useFakeTimers();
		let keypressHandler:
			| ((str: string, key: { ctrl?: boolean; name?: string }) => void)
			| undefined;
		mockStdin.on.mockImplementation(
			(
				event: string,
				handler: (str: string, key: { ctrl?: boolean; name?: string }) => void,
			) => {
				if (event === "keypress") keypressHandler = handler;
			},
		);

		try {
			const pending = animatedIntro("one two three four five", {
				stdout: mockStdout as unknown as NodeJS.WriteStream,
				stdin: mockStdin as unknown as NodeJS.ReadStream,
				frameDelayMs: 10,
			});

			keypressHandler?.("", { name: "escape" });
			await vi.advanceTimersByTimeAsync(500);
			await expect(pending).resolves.toBeUndefined();

			const output = mockStdout.write.mock.calls
				.map((call) => String(call[0]))
				.join("");
			expect(output).not.toContain("five");
			expect(output.split("\x1b[2F")).toHaveLength(1);
			expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	test("Ctrl+C restores stdin then throws InterruptError", async () => {
		vi.useFakeTimers();
		let keypressHandler:
			| ((str: string, key: { ctrl?: boolean; name?: string }) => void)
			| undefined;
		mockStdin.on.mockImplementation(
			(
				event: string,
				handler: (str: string, key: { ctrl?: boolean; name?: string }) => void,
			) => {
				if (event === "keypress") keypressHandler = handler;
			},
		);

		try {
			const pending = animatedIntro("one two three four five", {
				stdout: mockStdout as unknown as NodeJS.WriteStream,
				stdin: mockStdin as unknown as NodeJS.ReadStream,
				frameDelayMs: 10,
			});

			keypressHandler?.("", { ctrl: true, name: "c" });
			const assertion = expect(pending).rejects.toBeInstanceOf(InterruptError);
			await vi.advanceTimersByTimeAsync(500);
			await assertion;

			const output = mockStdout.write.mock.calls
				.map((call) => String(call[0]))
				.join("");
			expect(output).not.toContain("five");
			expect(mockStdin.setRawMode).toHaveBeenCalledWith(false);
		} finally {
			vi.useRealTimers();
		}
	});

	test("ignores keypresses that are not Escape or Ctrl+C", async () => {
		vi.useFakeTimers();
		let keypressHandler:
			| ((str: string, key?: { ctrl?: boolean; name?: string }) => void)
			| undefined;
		mockStdin.on.mockImplementation(
			(
				event: string,
				handler: (str: string, key?: { ctrl?: boolean; name?: string }) => void,
			) => {
				if (event === "keypress") keypressHandler = handler;
			},
		);

		try {
			const pending = animatedIntro("one two", {
				stdout: mockStdout as unknown as NodeJS.WriteStream,
				stdin: mockStdin as unknown as NodeJS.ReadStream,
				frameDelayMs: 10,
			});

			expect(() => keypressHandler?.("", undefined)).not.toThrow();
			keypressHandler?.("", { name: "c" });
			keypressHandler?.("", { ctrl: true, name: "a" });
			await vi.advanceTimersByTimeAsync(500);
			await expect(pending).resolves.toBeUndefined();

			const output = mockStdout.write.mock.calls
				.map((call) => String(call[0]))
				.join("");
			expect(output).toContain("one two");
		} finally {
			vi.useRealTimers();
		}
	});

	test("falls back to 80 columns when stdout.columns is unset", async () => {
		mockStdout.isTTY = false;
		mockStdout.columns = undefined;
		const message = "a".repeat(50);

		await animatedIntro(message, {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(stripVTControlCharacters(output)).toContain(message);
		expect(output).not.toContain("...");
	});

	test("treats a zero column width as unset and uses the 80-column fallback", async () => {
		mockStdout.isTTY = false;
		mockStdout.columns = 0;
		const message = "a".repeat(50);

		await animatedIntro(message, {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(stripVTControlCharacters(output)).toContain(message);
		expect(output).not.toContain("...");
	});

	test("uses at least 40 columns when stdout.columns is set", async () => {
		mockStdout.isTTY = false;
		mockStdout.columns = 80;
		const message = "a".repeat(50);

		await animatedIntro(message, {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(stripVTControlCharacters(output)).toContain(message);
		expect(output).not.toContain("...");
	});

	test("falls back to 80 columns on a TTY when stdout.columns is unset", async () => {
		mockStdout.columns = undefined;
		const message = "a".repeat(50);

		await animatedIntro(message, {
			stdout: mockStdout as unknown as NodeJS.WriteStream,
			stdin: mockStdin as unknown as NodeJS.ReadStream,
			frameDelayMs: 1,
		});

		const output = mockStdout.write.mock.calls.map((call) => call[0]).join("");
		expect(stripVTControlCharacters(output)).toContain(message);
		expect(output).not.toContain("...");
	});

	describe("createFixedHeightRenderer", () => {
		test("pads missing lines with empty strings on first paint", () => {
			const renderer = createFixedHeightRenderer(
				mockStdout as unknown as NodeJS.WriteStream,
				3,
			);

			renderer.paint(["only-one"]);

			expect(mockStdout.write.mock.calls.map((call) => call[0])).toEqual([
				"only-one",
				"\n",
				"",
				"\n",
				"",
			]);
		});

		test("repaints in place with clear-line sequences between rows", () => {
			const renderer = createFixedHeightRenderer(
				mockStdout as unknown as NodeJS.WriteStream,
				3,
			);

			renderer.paint(["a", "b", "c"]);
			mockStdout.write.mockClear();
			renderer.paint(["x", "y", "z"]);

			expect(mockStdout.write.mock.calls.map((call) => call[0])).toEqual([
				"\x1b[2F",
				"\x1b[2K",
				"x",
				"\n",
				"\x1b[2K",
				"y",
				"\n",
				"\x1b[2K",
				"z",
			]);
		});

		test("finish writes a trailing newline only after a paint", () => {
			const renderer = createFixedHeightRenderer(
				mockStdout as unknown as NodeJS.WriteStream,
				3,
			);

			renderer.finish();
			expect(mockStdout.write).not.toHaveBeenCalled();

			renderer.paint(["a", "b", "c"]);
			mockStdout.write.mockClear();
			renderer.finish();
			expect(mockStdout.write.mock.calls.map((call) => call[0])).toEqual([
				"\n",
			]);

			mockStdout.write.mockClear();
			renderer.finish();
			expect(mockStdout.write).not.toHaveBeenCalled();
		});
	});
});
