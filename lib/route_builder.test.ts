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

	test("carries section and ordering metadata", () => {
		const defs: RouteDefinition[] = [{ url: "/tables", nav_title_key: "reeman.tables", module: "system", nav_module: null, nav_section_key: "reeman.nav.generator", nav_item_order: 10, nav_section_order: 20, nav_group_order: 30 }];
		expect(build_nav_routes(defs)[0]).toMatchObject({ nav_section_key: "reeman.nav.generator", nav_item_order: 10, nav_section_order: 20, nav_group_order: 30 });
	});

	test("rejects non-finite navigation order", () => {
		const defs: RouteDefinition[] = [{ url: "/tables", nav_title_key: "tables", nav_item_order: Number.NaN }];
		expect(() => build_nav_routes(defs)).toThrow("nav_item_order");
	});

	test("groups sectioned and unsectioned entries with stable explicit ordering", () => {
		const nav = build_nav_routes([
			{ url: "/flat", nav_title_key: "flat", nav_item_order: 20 },
			{ url: "/second", nav_title_key: "second", nav_section_key: "reeman.nav.data", nav_section_order: 20, nav_item_order: 20 },
			{ url: "/first", nav_title_key: "first", nav_section_key: "reeman.nav.generator", nav_section_order: 10, nav_item_order: 10 },
			{ url: "/flat-first", nav_title_key: "flat-first", nav_item_order: 10 },
		]);
		const group = build_nav_groups(nav)[0]!;
		expect(group.items.map((entry) => entry.url)).toEqual(["/flat-first", "/flat"]);
		expect(group.sections.map((section) => section.key)).toEqual(["reeman.nav.generator", "reeman.nav.data"]);
		expect(group.sections[0]?.items.map((entry) => entry.url)).toEqual(["/first"]);
	});

	test("rejects conflicting section order declarations", () => {
		const nav = build_nav_routes([
			{ url: "/one", nav_title_key: "one", nav_section_key: "reeman.nav.data", nav_section_order: 10 },
			{ url: "/two", nav_title_key: "two", nav_section_key: "reeman.nav.data", nav_section_order: 20 },
		]);
		expect(() => build_nav_groups(nav)).toThrow("conflicting nav_section_order");
	});
});
