import { describe, expect, test } from "bun:test";

import type { RouteSchema } from "$generator/reeman/utils/route_scan";

import { route_edit_path, route_edit_paths_by_table, route_settings_from_module } from "./route_settings";

describe("route_settings_from_module", () => {
	test("exposes current editable table settings", () => {
		const route: RouteSchema = { table: "users", prefix: "system", url: "/system/users" };
		const settings = route_settings_from_module(route, {
			columns: {
				checkbox: { width: "10ch", class: "text-center" },
				id: { width: "10ch", class: "", grid: false },
				name: { width: "auto", class: "font-semibold", filter: true },
				email: { width: "30ch", class: "", grid: false },
			},
			pagination_strategy: "cursor",
			render_strategy: "stream",
			template_tags: "tags",
		});

		expect(settings.grid_columns).toEqual([
			{ name: "name", default_selected: true, width: "auto", class_name: "font-semibold", filter: true },
			{ name: "email", default_selected: false, width: "30ch", class_name: "", filter: false },
		]);
		expect(settings.pagination_strategy).toBe("cursor");
		expect(settings.render_strategy).toBe("stream");
		expect(settings.template_tags).toBe("tags");
	});
});

describe("route edit links", () => {
	test("encodes a route URL as a stable edit path", () => {
		expect(route_edit_path("/admin/frameworks")).toBe("/routes/edit?url=%2Fadmin%2Fframeworks");
	});

	test("maps each table to its first discovered CRUD route", () => {
		const paths = route_edit_paths_by_table([
			{ table: "frameworks", prefix: "", url: "/frameworks" },
			{ table: "frameworks", prefix: "admin", url: "/admin/frameworks" },
			{ table: "users", prefix: "system", url: "/system/users" },
		]);
		expect(paths).toEqual({
			frameworks: "/routes/edit?url=%2Fframeworks",
			users: "/routes/edit?url=%2Fsystem%2Fusers",
		});
	});
});
