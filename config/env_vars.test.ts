import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { KNOWN_ENV_VARS, N_A, check_env_vars, env_available, env_switch_on, env_var_groups, inconsistent_env_groups, invalid_env_values, is_env_present, missing_env_vars, redis_available } from "./env_vars";

describe("KNOWN_ENV_VARS", () => {
	test("is a stable, non-empty inventory", () => {
		expect(KNOWN_ENV_VARS.length).toBeGreaterThan(0);
	});

	test("contains no duplicates", () => {
		expect(new Set(KNOWN_ENV_VARS).size).toBe(KNOWN_ENV_VARS.length);
	});

	test("contains the core connection variables", () => {
		for (const name of ["DEV_CONNECTION_STRING", "PROD_CONNECTION_STRING", "TEST_CONNECTION_STRING", "PORT", "STORAGE"]) {
			expect(KNOWN_ENV_VARS).toContain(name);
		}
	});
});

describe("KNOWN_ENV_VARS stays in sync with .env.example", () => {
	const env_example_path = join(import.meta.dir, "..", ".env.example");

	function live_names(content: string): string[] {
		const names: string[] = [];
		for (const line of content.split(/\r?\n/)) {
			const name = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
			if (name !== undefined) names.push(name);
		}
		return names;
	}

	test("every live .env.example assignment is in KNOWN_ENV_VARS", async () => {
		const content = await Bun.file(env_example_path).text();
		const known = new Set(KNOWN_ENV_VARS);
		const undocumented = live_names(content).filter((name) => !known.has(name));
		expect(undocumented).toEqual([]);
	});
});

describe("is_env_present", () => {
	test("false when absent", () => expect(is_env_present("MISSING", {})).toBe(false));

	test("false when blank", () => {
		expect(is_env_present("EMPTY", { EMPTY: "" })).toBe(false);
		expect(is_env_present("SPACES", { SPACES: "   " })).toBe(false);
	});

	test("true for the N/A marker", () => expect(is_env_present("X", { X: N_A })).toBe(true));

	test("true for a real value", () => expect(is_env_present("X", { X: "value" })).toBe(true));
});

describe("env_available", () => {
	test("false when absent", () => expect(env_available("MISSING", {})).toBe(false));

	test("false for the exact N/A marker", () => expect(env_available("X", { X: N_A })).toBe(false));

	test("false for N/A with surrounding whitespace", () => expect(env_available("X", { X: "  N/A  " })).toBe(false));

	test("false when blank", () => expect(env_available("X", { X: "" })).toBe(false));

	test("true for a real value", () => expect(env_available("X", { X: "value" })).toBe(true));
});

describe("env_switch_on", () => {
	test("false when absent, blank, or N/A", () => {
		expect(env_switch_on("X", {})).toBe(false);
		expect(env_switch_on("X", { X: "" })).toBe(false);
		expect(env_switch_on("X", { X: N_A })).toBe(false);
	});

	test("false for the literal \"false\" regardless of case and whitespace", () => {
		expect(env_switch_on("X", { X: "false" })).toBe(false);
		expect(env_switch_on("X", { X: "FALSE" })).toBe(false);
		expect(env_switch_on("X", { X: " False " })).toBe(false);
	});

	test("true for \"true\" or \"on\" regardless of case and whitespace", () => {
		expect(env_switch_on("X", { X: "true" })).toBe(true);
		expect(env_switch_on("X", { X: "TRUE" })).toBe(true);
		expect(env_switch_on("X", { X: " True " })).toBe(true);
		expect(env_switch_on("X", { X: "on" })).toBe(true);
		expect(env_switch_on("X", { X: "ON" })).toBe(true);
		expect(env_switch_on("X", { X: " On " })).toBe(true);
	});

	test("false for any other real value", () => {
		expect(env_switch_on("X", { X: "1" })).toBe(false);
		expect(env_switch_on("X", { X: "yes" })).toBe(false);
		expect(env_switch_on("X", { X: "anything" })).toBe(false);
	});
});

describe("redis_available", () => {
	test("false when REDIS_ENABLED is absent, blank, or N/A even with a real URL", () => {
		expect(redis_available({ REDIS_URL: "redis://localhost:6379" })).toBe(false);
		expect(redis_available({ REDIS_ENABLED: "", REDIS_URL: "redis://localhost:6379" })).toBe(false);
		expect(redis_available({ REDIS_ENABLED: N_A, REDIS_URL: "redis://localhost:6379" })).toBe(false);
	});

	test("false when REDIS_ENABLED is \"false\" or any other non-true value", () => {
		expect(redis_available({ REDIS_ENABLED: "false", REDIS_URL: "redis://localhost:6379" })).toBe(false);
		expect(redis_available({ REDIS_ENABLED: "1", REDIS_URL: "redis://localhost:6379" })).toBe(false);
	});

	test("false when REDIS_URL is absent, blank, or N/A even with the switch on", () => {
		expect(redis_available({ REDIS_ENABLED: "true" })).toBe(false);
		expect(redis_available({ REDIS_ENABLED: "true", REDIS_URL: "" })).toBe(false);
		expect(redis_available({ REDIS_ENABLED: "true", REDIS_URL: N_A })).toBe(false);
	});

	test("true only when REDIS_ENABLED is \"true\" or \"on\" and REDIS_URL is real", () => {
		expect(redis_available({ REDIS_ENABLED: "true", REDIS_URL: "redis://localhost:6379" })).toBe(true);
		expect(redis_available({ REDIS_ENABLED: "on", REDIS_URL: "redis://localhost:6379" })).toBe(true);
		expect(redis_available({ REDIS_ENABLED: "TRUE", REDIS_URL: " redis://localhost:6379 " })).toBe(true);
	});
});

describe("missing_env_vars", () => {
	test("returns only absent and blank names", () => {
		const env = { PRESENT: "yes", MARKED: N_A, EMPTY: "", ABSENT: undefined };
		expect(missing_env_vars(["PRESENT", "MARKED", "EMPTY", "ABSENT", "NEVER_SET"], env)).toEqual(["EMPTY", "ABSENT", "NEVER_SET"]);
	});
});

describe("invalid_env_values", () => {
	test("flags a value outside the declared enum", () => {
		expect(invalid_env_values({ STORAGE: "bogus" })).toEqual([{ name: "STORAGE", value: "bogus", allowed: ["local", "s3"] }]);
	});

	test("matches allowed values case-insensitively", () => {
		expect(invalid_env_values({ STORAGE: "S3", TRUST_PROXY: "Direct" })).toEqual([]);
	});

	test("ignores absent, blank, and N/A values", () => {
		expect(invalid_env_values({ STORAGE: N_A, TRUST_PROXY: "", SESSION_STORE: undefined })).toEqual([]);
	});
});

describe("check_env_vars", () => {
	test("reports every known name missing against an empty environment", () => {
		const result = check_env_vars({});

		expect(result.names).toEqual([...KNOWN_ENV_VARS]);
		expect(result.missing).toEqual([...KNOWN_ENV_VARS]);
		expect(result.available).toEqual([]);
		expect(result.unavailable).toEqual([]);
		expect(result.invalid).toEqual([]);
	});

	test("splits known names into missing / available / unavailable", () => {
		const env: Record<string, string> = { STORAGE: "local", SESSION_STORE: N_A };
		const result = check_env_vars(env);

		expect(result.available).toContain("STORAGE");
		expect(result.unavailable).toContain("SESSION_STORE");
		expect(result.missing).toContain("PORT");
		expect(result.missing).not.toContain("STORAGE");
		expect(result.missing).not.toContain("SESSION_STORE");
	});

	test("reports enum violations as invalid", () => {
		const result = check_env_vars({ STORAGE: "ftp" });
		expect(result.invalid).toEqual([{ name: "STORAGE", value: "ftp", allowed: ["local", "s3"] }]);
	});

	test("does not flag N/A as invalid", () => {
		const result = check_env_vars({ STORAGE: N_A, TRUST_PROXY: N_A });
		expect(result.invalid).toEqual([]);
		expect(result.unavailable).toContain("STORAGE");
		expect(result.unavailable).toContain("TRUST_PROXY");
	});

	test("reports no inconsistent groups against an empty environment", () => {
		expect(check_env_vars({}).inconsistent_groups).toEqual([]);
	});
});

describe("inconsistent_env_groups", () => {
	test("switch off - members left N/A is not flagged (config preserved, feature off)", () => {
		const env = { SMTP_ENABLED: N_A, SMTP_HOST: "mail.example.com", SMTP_PORT: N_A, SMTP_USERNAME: N_A, SMTP_PASSWORD: N_A, SMTP_FROM: N_A };
		expect(inconsistent_env_groups(env)).toEqual([]);
	});

	test("switch explicitly \"false\" - members left N/A is not flagged (documented off value)", () => {
		const env = { SMTP_ENABLED: "false", SMTP_HOST: N_A, SMTP_PORT: N_A, SMTP_USERNAME: N_A, SMTP_PASSWORD: N_A, SMTP_FROM: N_A };
		expect(inconsistent_env_groups(env)).toEqual([]);
	});

	test("switch on - every member real is not flagged", () => {
		const env = { SMTP_ENABLED: "true", SMTP_HOST: "mail.example.com", SMTP_PORT: "587", SMTP_USERNAME: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@b.com" };
		expect(inconsistent_env_groups(env)).toEqual([]);
	});

	test("switch on - a member still N/A is flagged with the missing member name", () => {
		const env = { SMTP_ENABLED: "true", SMTP_HOST: "mail.example.com", SMTP_PORT: N_A, SMTP_USERNAME: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@b.com" };
		expect(inconsistent_env_groups(env)).toEqual([{ group: "SMTP", switch: "SMTP_ENABLED", missing_members: ["SMTP_PORT"] }]);
	});

	test("switch on - multiple members absent are all listed", () => {
		const env = { SMTP_ENABLED: "true", SMTP_HOST: "mail.example.com" };
		const result = inconsistent_env_groups(env);
		expect(result).toHaveLength(1);
		expect(result[0]!.missing_members).toEqual(expect.arrayContaining(["SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"]));
	});

	test("every declared group's switch and members are known vars", () => {
		for (const { switch: switch_name, members } of Object.values(env_var_groups)) {
			expect(KNOWN_ENV_VARS).toContain(switch_name);
			for (const member of members) { expect(KNOWN_ENV_VARS).toContain(member); }
		}
	});
});
