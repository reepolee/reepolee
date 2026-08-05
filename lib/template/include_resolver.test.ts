import { describe, expect, test } from "bun:test";

import { resolve_include } from "./include_resolver";

const views_dir = "/project/routes";

describe("resolve_include", () => {
	test("rejects a template include that escapes the views directory", () => {
		expect(() => resolve_include("pages/home", "../../secret", views_dir, ".ree")).toThrow("Include path escapes base directory");
	});

	test("rejects an alias include that escapes the project directory", () => {
		expect(() => resolve_include("pages/home", "$components/../../secret", views_dir, ".ree")).toThrow("Include path escapes base directory");
	});

	test("does not mistake a sibling with a shared prefix for a child directory", () => {
		expect(() => resolve_include("pages/home", "../../routes-other/secret.txt", views_dir, ".ree")).toThrow("Include path escapes base directory");
	});

	test("keeps a relative template include inside the views directory", () => {
		const result = resolve_include("pages/home", "../shared/card", views_dir, ".ree");
		expect(result).toEqual({ kind: "template", template_name: "shared/card" });
	});
});
