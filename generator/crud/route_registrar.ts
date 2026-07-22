/**
 * Route Registrar - updates routes.ts during CRUD generation.
 *
 * Handles adding imports and route entries for both standalone
 * and nested CRUD routes.
 */

import { join } from "node:path";

import { add_static_route_definitions } from "../reeman/utils/routes_writer";

import { log_step } from "./helpers";

export interface RouteRegistrarResult {
	routes_content: string | null;
	modified: boolean;
}

/**
 * Read and possibly modify routes.ts for a new CRUD route.
 * Returns the modified content (or null if no change) and whether it was modified.
 * The caller must write the content AFTER translations are committed.
 */
export interface UpdateRoutesConfig {
	table_name: string;
	crud_name: string;
	clean_prefix: string;
	route_prefix: string;
	parent_cli_table: string;
	is_nested: boolean;
	route_name?: string;
}

export async function update_routes_ts(config: UpdateRoutesConfig): Promise<RouteRegistrarResult> {
	const { table_name, crud_name, clean_prefix, route_prefix, parent_cli_table, is_nested, route_name = "" } = config;
	const routes_path = join(process.cwd(), "routes", "routes.ts");
	log_step(`Checking routes.ts existence`);
	const routes_exists = await Bun.file(routes_path).exists();

	if (!routes_exists) {
		console.warn(`⚠  routes.ts not found at ${routes_path}\n` + `   The route for "${table_name}" was NOT registered. Add it manually or create routes.ts first.`);
		return { routes_content: null, modified: false };
	}

	log_step(`Reading routes.ts`);
	let routes_content = await Bun.file(routes_path).text();
	let routes_modified = false;

	// Build import path (uses route_name for directory, table_name for SQL)
	const dir_name = route_name || table_name;
	const import_path = parent_cli_table ? `${clean_prefix ? `${clean_prefix}/` : ""}${parent_cli_table}/${dir_name}` : clean_prefix ? `${clean_prefix}/${dir_name}` : dir_name;

	log_step(`routes.ts read (${routes_content.length} chars)`);

	// Nested CRUDs are spread directly into the routes export and need a static import.
	// Non-nested CRUDs are loaded via load_routes() - no static import needed.
	if (is_nested) {
		const import_stmt = `import { ${crud_name} } from "$routes/${import_path}";`;
		log_step(`Looking for import: ${import_stmt}`);
		const existing_import_regex = new RegExp(`import \\{ [^}]+ \\} from "\\$routes/${import_path}";`);
		if (existing_import_regex.test(routes_content) && !routes_content.includes(import_stmt)) {
			log_step(`Replacing existing import for "$routes/${import_path}" with: ${import_stmt}`);
			routes_content = routes_content.replace(existing_import_regex, import_stmt);
			routes_modified = true;
		} else if (!routes_content.includes(import_stmt)) {
			log_step(`Adding import to routes.ts: ${import_stmt}`);
			const lines = routes_content.split("\n");
			const last_idx = lines.findLastIndex((l) => l.trim().startsWith("import "));
			log_step(`Last import at line ${last_idx}`);
			lines.splice(last_idx + 1, 0, import_stmt);
			routes_content = lines.join("\n");
			routes_modified = true;
		}
	}

	// Add route definition
	if (!is_nested) {
		const load_result = add_static_route_definitions(routes_content, import_path);
		if (load_result.modified) {
			log_step(`Adding load_routes call for "$routes/${import_path}"`);
			routes_content = load_result.content;
			routes_modified = true;
		}
	} else if (routes_content.includes("// GENERATED CHILD CRUD:start") && routes_content.includes("// GENERATED CHILD CRUD:end")) {
		// Remove any standalone route entry for this nested child
		const standalone_regex = new RegExp(`\\t*\\{ url: "[^"]*", crud: ${crud_name},[^}]*\\},?\\n?`, "g");
		const before_cleanup = routes_content;
		routes_content = routes_content.replace(standalone_regex, "");
		if (routes_content !== before_cleanup) {
			routes_modified = true;
			log_step(`Removed standalone route_definitions entry for nested child ${table_name}`);
		}

		// Add spread entry to GENERATED CHILD CRUD section
		const spread_entry = `...${crud_name},`;
		if (!routes_content.includes(spread_entry)) {
			log_step(`Adding nested CRUD spread: ${spread_entry}`);
			const lines = routes_content.split("\n");
			const end_idx = lines.findIndex((l) => l.includes("// GENERATED CHILD CRUD:end"));
			if (end_idx >= 0) {
				const indent = lines[end_idx].match(/^\s*/)?.[0] || "\t";
				lines.splice(end_idx, 0, `${indent}${spread_entry}`);
				routes_content = lines.join("\n");
				routes_modified = true;
			}
		}
	} else {
		log_step(`Nested CRUD detected but no GENERATED CHILD CRUD markers in routes.ts`);
		console.log(
			`\n⚠  Nested CRUD generated for "${table_name}". To register routes, add a GENERATED CHILD CRUD section to routes.ts:\n  // GENERATED CHILD CRUD:start\n  ...${crud_name},\n  // GENERATED CHILD CRUD:end`
		);
	}

	return { routes_content: routes_modified ? routes_content : null, modified: routes_modified };
}
