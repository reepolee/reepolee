import { describe, expect, test } from "bun:test";

import { build_code_search_args, resolve_route_dir, resolve_template_file } from "./paths";

describe("MCP template paths", () => {
	test("allows .ree files under routes and components", () => {
		expect(resolve_template_file("routes/home/index.ree")).toEndWith("routes/home/index.ree");
		expect(resolve_template_file("components/app-banner.ree")).toEndWith("components/app-banner.ree");
	});

	test("rejects environment files, traversal, and arbitrary project files", () => {
		for (const path of [".env", "routes/../../.env", "routes/home/index.ts", "package.json", "/etc/passwd", "components\\app-banner.ree"]) {
			expect(() => resolve_template_file(path)).toThrow();
		}
	});
});

describe("MCP route paths", () => {
	test("rejects route traversal", () => {
		expect(() => resolve_route_dir("/../../.env")).toThrow();
	});
});

describe("MCP code search arguments", () => {
	test("excludes secrets, VCS metadata, dependencies, and archives", () => {
		const args = build_code_search_args("password");

		expect(args).toContain("!.env");
		expect(args).toContain("!**/.git/**");
		expect(args).toContain("!**/node_modules/**");
		expect(args).toContain("!**/*.zip");
	});

	test("rejects an unsafe user-provided glob", () => {
		for (const glob of ["../.env", ".env", "**/.git/**", "**/*secret*"]) {
			expect(() => build_code_search_args("password", glob)).toThrow();
		}
	});
});
