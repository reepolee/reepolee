import { join } from "node:path";

import { MAIN_APP } from "$config/paths";
import type { RouteSchema } from "$generator/reeman/utils/route_scan";
import { load_table_module_fresh } from "$generator/schema/table_module_loader";

export interface RouteGridColumn {
	name: string;
	default_selected: boolean;
	width: string;
	class_name: string;
	filter: boolean;
}

export interface RouteSettings {
	route: RouteSchema;
	grid_columns: RouteGridColumn[];
	pagination_strategy: "cursor" | "offset";
	render_strategy: "stream" | "load";
	template_tags: "flat" | "tags";
}

export function route_edit_path(url: string): string {
	const encoded_url = encodeURIComponent(url);
	return `/routes/edit?url=${encoded_url}`;
}

export function route_edit_paths_by_table(routes: RouteSchema[]): Record<string, string> {
	const paths: Record<string, string> = {};
	for (const route of routes) {
		if (paths[route.table]) continue;
		paths[route.table] = route_edit_path(route.url);
	}
	return paths;
}

type TableColumn = {
	width: string;
	class: string;
	filter?: boolean;
	grid?: boolean;
};

type TableModule = {
	columns: Record<string, TableColumn>;
	pagination_strategy: "cursor" | "offset";
	render_strategy: "stream" | "load";
	template_tags: "flat" | "tags";
};

export function route_settings_from_module(route: RouteSchema, table_module: TableModule): RouteSettings {
	const column_entries = Object.entries(table_module.columns);
	const editable_entries = column_entries.filter(([name]) => name !== "checkbox" && name !== "id");
	const grid_columns = editable_entries.map(([name, column]) => ({
		name,
		default_selected: column.grid !== false,
		width: column.width,
		class_name: column.class,
		filter: column.filter === true,
	}));

	return {
		route,
		grid_columns,
		pagination_strategy: table_module.pagination_strategy,
		render_strategy: table_module.render_strategy,
		template_tags: table_module.template_tags,
	};
}

export async function load_route_settings(url: string): Promise<RouteSettings | null> {
	const { discover_routes_with_schema } = await import("$generator/reeman/utils/route_scan");
	const routes = discover_routes_with_schema();
	const route = routes.find((candidate) => candidate.url === url);
	if (!route) return null;

	const raw_parts = route.url.split("/");
	const route_parts = raw_parts.filter(Boolean);
	const table_path = join(process.cwd(), MAIN_APP, ...route_parts, "schema", "table.ts");
	const table_module = await load_table_module_fresh<TableModule>(table_path);

	return route_settings_from_module(route, table_module);
}
