import { join } from "node:path";

import { MAIN_APP } from "$config/paths";
import { default_field_helper, type DefaultHelperField } from "$generator/crud/render_field_cell";
import type { RouteSchema } from "$generator/reeman/utils/route_scan";
import { load_table_module_fresh } from "$generator/schema/table_module_loader";

export interface RouteGridColumn {
	name: string;
	default_selected: boolean;
	width: string;
	class_name: string;
	filter: boolean;
	localized: boolean;
	readonly: boolean;
	form: boolean;
	is_new: boolean;
	/** Built-in template helper applied to this column's grid cell ("" = default). */
	helper: string;
	/** The type-based helper the CRUD generator would apply if none is selected. */
	default_helper: string;
}

export interface RouteSettings {
	route: RouteSchema;
	grid_columns: RouteGridColumn[];
	has_new_columns: boolean;
	grid_cols: string;
	pagination_strategy: "cursor" | "offset";
	render_strategy: "stream" | "load";
	template_tags: "flat" | "tags";
	form_hints: boolean;
	form_details: boolean;
	/** A route can move only when it is not a child and owns no child CRUD routes. */
	can_move_module?: boolean;
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
	helper?: string;
	grid?: boolean;
	localized?: boolean;
	readonly?: boolean;
	form?: boolean;
	new?: boolean;
};

type TableModule = {
	columns: Record<string, TableColumn>;
	pagination_strategy: "cursor" | "offset";
	render_strategy: "stream" | "load";
	template_tags: "flat" | "tags";
	form_hints?: boolean;
	form_details?: boolean;
	/** Field metadata (type, attributes) keyed by column name, from schema.generated.ts. */
	fields?: Record<string, DefaultHelperField>;
};

export function route_settings_from_module(route: RouteSchema, table_module: TableModule, fields: Record<string, DefaultHelperField> | undefined = table_module.fields): RouteSettings {
	const column_entries = Object.entries(table_module.columns);
	const editable_entries = column_entries.filter(([name]) => name !== "checkbox" && name !== "id");
	const grid_columns = editable_entries.map(([name, column]) => ({
		name,
		default_selected: column.grid !== false,
		width: column.width,
		class_name: column.class,
		filter: column.filter === true,
		localized: column.localized === true,
		readonly: column.readonly === true,
		form: column.form !== false,
		is_new: column.new === true,
		helper: column.helper ?? "",
		default_helper: fields?.[name] ? default_field_helper(fields[name]!) : "",
	}));

	const has_new_columns = grid_columns.some((column) => column.is_new);
	const grid_cols = `${has_new_columns ? "auto " : ""}minmax(0,1fr) 12ch minmax(0,1fr) minmax(0,22ch) auto auto auto auto`;

	return {
		route,
		grid_columns,
		has_new_columns,
		grid_cols,
		pagination_strategy: table_module.pagination_strategy,
		render_strategy: table_module.render_strategy,
		template_tags: table_module.template_tags,
		form_hints: table_module.form_hints === true,
		form_details: table_module.form_details === true,
	};
}

export async function load_route_settings(url: string): Promise<RouteSettings | null> {
	const { discover_routes_with_schema } = await import("$generator/reeman/utils/route_scan");
	const routes = discover_routes_with_schema();
	const route = routes.find((candidate) => candidate.url === url);
	if (!route) return null;

	const raw_parts = route.url.split("/");
	const route_parts = raw_parts.filter(Boolean);
	const table_path = join(process.cwd(), MAIN_APP, ...route_parts, "config.ts");
	const table_module = await load_table_module_fresh<TableModule>(table_path);

	const settings = route_settings_from_module(route, table_module);
	settings.can_move_module = !route.parent && !routes.some((candidate) => candidate.url.startsWith(`${route.url}/`));
	return settings;
}
