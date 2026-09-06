import { describe, expect, test } from "bun:test";

import { ENV_VAR_DESCRIPTIONS, env_var_description } from "./env_var_descriptions";
import { KNOWN_ENV_VARS } from "./env_vars";

describe("env var descriptions", () => {
	test("every known variable has a description", () => {
		const undescribed = KNOWN_ENV_VARS.filter((name) => !ENV_VAR_DESCRIPTIONS[name]?.trim());
		expect(undescribed).toEqual([]);
	});

	test("no description exists for a variable outside the inventory", () => {
		const known = new Set(KNOWN_ENV_VARS);
		const orphaned = Object.keys(ENV_VAR_DESCRIPTIONS).filter((name) => !known.has(name));
		expect(orphaned).toEqual([]);
	});

	test("lookup returns an empty string for an unknown variable", () => {
		expect(env_var_description("NOT_A_REAL_VARIABLE")).toBe("");
	});

	test("descriptions are single-line, so the reeman table stays readable", () => {
		const multiline = Object.entries(ENV_VAR_DESCRIPTIONS)
			.filter(([, description]) => description.includes("\n"))
			.map(([name]) => name);
		expect(multiline).toEqual([]);
	});
});
