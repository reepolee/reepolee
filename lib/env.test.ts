import { afterEach, describe, expect, test } from "bun:test";

const env = await import("./env");

describe("sanitize_env_value", () => {
	test("strips double quotes from ends", () => expect(env.sanitize_env_value("\"sqlite:app.db\"")).toBe("sqlite:app.db"));

	test("strips single quotes from ends", () => expect(env.sanitize_env_value("'mysql://localhost'")).toBe("mysql://localhost"));

	test("strips surrounding whitespace", () => expect(env.sanitize_env_value("  hello  ")).toBe("hello"));

	test("strips mixed quotes and whitespace", () => expect(env.sanitize_env_value("  \"value\"  ")).toBe("value"));

	test("returns unchanged if no quotes or whitespace", () => expect(env.sanitize_env_value("plain")).toBe("plain"));

	test("strips only outer quotes, keeps inner quotes", () => expect(env.sanitize_env_value("\"it's ok\"")).toBe("it's ok"));

	test("handles empty string", () => expect(env.sanitize_env_value("")).toBe(""));

	test("handles only whitespace", () => expect(env.sanitize_env_value("   ")).toBe(""));

	test("preserves internal whitespace", () => expect(env.sanitize_env_value("\" hello world \"")).toBe("hello world"));
});

describe("get_storage_mode", () => {
	const original_storage = Bun.env.STORAGE;

	afterEach(() => {
		// Restore after each test
		if (original_storage === undefined) {
			delete Bun.env.STORAGE;
		} else {
			Bun.env.STORAGE = original_storage;
		}
	});

	test("returns null when STORAGE not set", () => {
		delete Bun.env.STORAGE;
		expect(env.get_storage_mode()).toBeNull();
	});

	test("returns 'local' for 'local' value", () => {
		Bun.env.STORAGE = "local";
		expect(env.get_storage_mode()).toBe("local");
	});

	test("returns 's3' for 's3' value", () => {
		Bun.env.STORAGE = "s3";
		expect(env.get_storage_mode()).toBe("s3");
	});

	test("case insensitive - handles uppercase", () => {
		Bun.env.STORAGE = "LOCAL";
		expect(env.get_storage_mode()).toBe("local");
	});

	test("trims whitespace from value", () => {
		Bun.env.STORAGE = "  s3  ";
		expect(env.get_storage_mode()).toBe("s3");
	});

	test("fails loud for invalid value (process.exit)", () => {
		Bun.env.STORAGE = "invalid";
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			expect(() => env.get_storage_mode()).toThrow("process.exit(1)");
		} finally {
			(process as any).exit = original_exit;
		}
	});
});

describe("require_env", () => {
	test("returns value when env var is set", () => {
		Bun.env.TEST_VAR = "hello";
		expect(env.require_env("TEST_VAR")).toBe("hello");
	});

	test("strips quotes from value", () => {
		Bun.env.TEST_VAR = "\"quoted\"";
		expect(env.require_env("TEST_VAR")).toBe("quoted");
	});

	test("fails loud when env var not set (process.exit)", () => {
		delete Bun.env.TEST_VAR;
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			expect(() => env.require_env("TEST_VAR")).toThrow("process.exit(1)");
		} finally {
			(process as any).exit = original_exit;
		}
	});
});
