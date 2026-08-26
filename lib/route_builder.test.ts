import { describe, expect, test } from "bun:test";

import { build_nav_routes, build_routes, type RouteDefinition } from "$lib/route_builder";
import { build_nav_groups } from "$lib/route_table";

describe("build_nav_routes", () => {
	test("nav_module defaults to module (backwards compatible)", () => {
		const defs: RouteDefinition[] = [{ url: "/admin/users", nav_title_key: "admin.users", module: "admin" }];
		expect(build_nav_routes(defs)).toEqual([
			{ url: "/admin/users", nav_title_key: "admin.users", module: "admin", required_module: "admin", is_menu_entry: true },
		]);
	});

	test("nav_module: null keeps auth module but groups nav at root", () => {
		const defs: RouteDefinition[] = [
			{ url: "/users", crud: { "/users": { GET: async () => new Response() } }, nav_title_key: "users", module: "system", nav_module: null },
			{ url: "/admin/users", nav_title_key: "admin.users", module: "admin" },
		];

		const nav = build_nav_routes(defs);
		expect(nav).toEqual([
			{ url: "/users", nav_title_key: "users", module: null, required_module: "system", is_menu_entry: true },
			{ url: "/admin/users", nav_title_key: "admin.users", module: "admin", required_module: "admin", is_menu_entry: true },
		]);

		// Flat entries land in the untagged root group, not under "system", but
		// still carry the auth module so the layout can hide them from users
		// without the "system" module.
		const groups = build_nav_groups(nav);
		expect(groups.map((g) => g.label)).toEqual(["", "admin"]);
		expect(groups[0]!.items.map((i) => i.url)).toEqual(["/users"]);
		expect(groups[0]!.items[0]!.required_module).toBe("system");
	});

	test("is_menu_entry: false excludes the entry from the nav", () => {
		const defs: RouteDefinition[] = [{ url: "/studio", crud: { "/studio": { GET: async () => new Response() } }, nav_title_key: "studio", module: "system", nav_module: null, is_menu_entry: false }];
		const nav = build_nav_routes(defs);
		expect(nav).toEqual([]);
	});

	test("nav_rule_after only lands on the flagged entry", () => {
		const defs: RouteDefinition[] = [
			{ url: "/tables", nav_title_key: "tables", module: "system", nav_module: null, nav_rule_after: true },
			{ url: "/files", nav_title_key: "files", module: "system", nav_module: null },
		];

		const nav = build_nav_routes(defs);
		expect(nav[0]!.nav_rule_after).toBe(true);
		expect(nav[1]!.nav_rule_after).toBeUndefined();
	});

	test("auth gating still uses module, not nav_module", () => {
		const defs: RouteDefinition[] = [
			{ url: "/users", crud: { "/users": { GET: async () => new Response() } }, nav_title_key: "users", module: "system", nav_module: null },
		];
		const routes = build_routes(defs);
		expect(Object.keys(routes)).toEqual(["/users"]);
	});
});
