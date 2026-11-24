import { describe, expect, test } from "bun:test";

import { add_static_route_definitions } from "./routes_writer";

describe("add_static_route_definitions", () => {
	test("inserts a spread before the array closing delimiter", () => {
		const routes = [
			"import { build_routes, type RouteDefinition } from \"$lib/route_builder\";",
			"",
			"const route_definitions: RouteDefinition[] = [",
			"\t{ url: \"/\", handler: home_page },",
			"];",
			"",
			"export const nav_routes = build_nav_routes(route_definitions);",
			"export const routes = build_routes(route_definitions);",
		].join("\n");

		const result = add_static_route_definitions(routes, "new_route");

		expect(result.modified).toBe(true);
		expect(result.content).toContain("...new_route,");
		expect(result.content).toContain("...new_route,\n];");
		expect(result.content).toContain("export const nav_routes = build_nav_routes(route_definitions);");
		expect(result.content).toContain("export const routes = build_routes(route_definitions);");
	});
});
