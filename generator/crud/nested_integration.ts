/**
 * Nested CRUD Integration - injects child CRUD into parent files.
 *
 * Uses marker comments where available (form.ree: <!-- crud:children:start/end -->).
 * For index.ts injection, adds markers if not present, falls back to regex for existing files.
 */

import { join, relative } from "node:path";

import { generate_child_section_html } from "./child_section";
import { capitalize_first } from "../naming";
import { escape_regex, log_step } from "./helpers";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";

// Marker constants

const CHILD_IMPORT_START = "// crud:child:import:start";
const CHILD_IMPORT_END = "// crud:child:import:end";
const CHILD_FETCH_START = "// crud:child:fetch:start";
const CHILD_FETCH_END = "// crud:child:fetch:end";
const CHILD_DATA_START = "// crud:child:data:start";
const CHILD_DATA_END = "// crud:child:data:end";
const FORM_CHILD_START = "<!-- crud:children:start -->";
const FORM_CHILD_END = "<!-- crud:children:end -->";

// Public API

export interface NestedChildOptions {
	table_name: string;
	parent_info: ParentInfo;
	parent_dir: string;
	fields: FieldDef[];
	v_fields: FieldDef[] | null;
	columns: Record<string, any> | null;
	foreign_keys: ForeignKeyMap;
	route_prefix: string;
	route_dir: string;
}

export async function integrate_nested_child(options: NestedChildOptions): Promise<void> {
	const { table_name, parent_info, parent_dir, fields, v_fields, columns, foreign_keys, route_prefix, route_dir } = options;
	log_step(`Integrating child "${table_name}" into parent "${parent_info.table}"`);

	const child_fn_name = `get_${table_name}_by_${parent_info.fk_column}`;
	const child_label = capitalize_first(table_name.replace(/_/g, " "));

	// --- Inject child query function into parent sql.ts ---
	await inject_parent_sql(parent_dir, table_name, parent_info, v_fields, child_fn_name);

	// --- Determine child variable names (disambiguate if multiple children) ---
	const var_names = await determine_child_vars(parent_dir, table_name);

	// --- Generate child section HTML ---
	const { child_section, child_fields_for_dialog } = await generate_child_section_html(
		table_name,
		parent_info,
		fields,
		v_fields,
		columns,
		foreign_keys,
		route_prefix,
		var_names.child_records_var,
		var_names.child_parent_label_var,
		var_names.child_ui_var,
		var_names.child_fields_var,
		var_names.child_columns_var
	);

	// FK selects in the child dialog loop over <fk.table>_options_by_<fk.column>,
	// so the parent edit handler must fetch those option lists (the parent FK
	// itself is already excluded from dialog fields; autocomplete needs none)
	const child_fk_options: { fn_name: string; var_name: string; }[] = [];
	for (const dialog_field of child_fields_for_dialog) {
		const fk_info = foreign_keys.get(dialog_field.name);
		if (!fk_info || dialog_field.type === "autocomplete") { continue; }
		child_fk_options.push({
			fn_name: `get_${fk_info.table}_options_by_${fk_info.column}`,
			var_name: `${fk_info.table}_options_by_${fk_info.column}`,
		});
	}

	// --- Inject into parent index.ts ---
	const parent_index_path = join(parent_dir, "index.ts");
	if (await Bun.file(parent_index_path).exists()) {
		await inject_parent_index_marker(
			parent_index_path,
			table_name,
			parent_info,
			child_fn_name,
			child_label,
			var_names,
			route_dir,
			child_fk_options
		);
	}

	// --- Inject into parent form.ree ---
	const parent_form_path = join(parent_dir, "form.ree");
	if (await Bun.file(parent_form_path).exists()) { await inject_parent_form_marker(parent_form_path, child_section, var_names.child_fields_var); }

	log_step(`Parent file integration complete for ${table_name}`);
}

// Child variable name disambiguation

async function determine_child_vars(parent_dir: string, table_name: string): Promise<{
	child_records_var: string;
	child_translated_var: string;
	child_parent_label_var: string;
	child_ui_var: string;
	child_fields_var: string;
	child_columns_var: string;
}> {
	const defaults = {
		child_records_var: "child_records",
		child_translated_var: "child_translated",
		child_parent_label_var: "parent_label",
		child_ui_var: "child_ui",
		child_fields_var: "child_fields",
		child_columns_var: "child_columns",
	};

	try {
		const content = await Bun.file(join(parent_dir, "index.ts")).text();
		if (content.includes("const child_records = await")) {
			return {
				child_records_var: `child_${table_name}_records`,
				child_translated_var: `child_${table_name}_translated`,
				child_parent_label_var: `child_${table_name}_parent_label`,
				child_ui_var: `child_${table_name}_ui`,
				child_fields_var: `child_${table_name}_fields`,
				child_columns_var: `child_${table_name}_columns`,
			};
		}
	} catch {
		// parent index.ts doesn't exist yet
	}

	return defaults;
}

// SQL injection

async function inject_parent_sql(
	parent_dir: string,
	table_name: string,
	parent_info: ParentInfo,
	v_fields: FieldDef[] | null,
	child_fn_name: string,
): Promise<void> {
	const parent_sql_path = join(parent_dir, "sql.ts");
	if (!(await Bun.file(parent_sql_path).exists())) return;

	let parent_sql = await Bun.file(parent_sql_path).text();
	if (parent_sql.includes(child_fn_name)) return;

	const view_source = v_fields ? `v_${table_name}` : table_name;
	const child_query_fn = [
		"",
		`export async function ${child_fn_name}(parent_id: number | string): Promise<Record<string, any>[]> {`,
		`\ttry {`,
		`\t\treturn await timed_query("${table_name}", "${child_fn_name}", async () => {`,
		`\t\t\tconst records = await db\`SELECT * FROM ${view_source} WHERE ${parent_info.fk_column} = \${parent_id} ORDER BY id ASC\`;`,
		`\t\t\treturn records as Record<string, any>[];`,
		`\t\t});`,
		`\t} catch (error) {`,
		`\t\tconsole.error("Error fetching ${table_name} for parent:", error);`,
		`\t\treturn [];`,
		`\t}`,
		`}`,
	].join("\n");

	parent_sql = `${parent_sql.trimEnd() + child_query_fn}\n`;
	await Bun.write(parent_sql_path, parent_sql);
	console.log(`✓ Added ${child_fn_name} to parent sql.ts`);
}

// Index.ts marker-based injection

async function inject_parent_index_marker(parent_index_path: string, table_name: string, parent_info: ParentInfo, child_fn_name: string, child_label: string, var_names: {
	child_records_var: string;
	child_translated_var: string;
	child_parent_label_var: string;
	child_ui_var: string;
	child_fields_var: string;
	child_columns_var: string;
}, route_dir: string, child_fk_options: { fn_name: string; var_name: string; }[] = []): Promise<void> {
	let parent_index = await Bun.file(parent_index_path).text();
	let parent_modified = false;

	// Normalize to forward slashes - on Windows relative() yields backslashes
	// which become escape sequences (\t, \n, ...) inside generated string literals
	const child_relative_path_raw = relative(join(process.cwd(), "routes"), route_dir);
	const child_relative_path = child_relative_path_raw.replaceAll("\\", "/");
	const child_columns_import_path = `./${table_name}/schema/table`;

	// Skip FK option lists the parent handler (or another child) already loads
	const new_fk_options = child_fk_options.filter((fk) => !parent_index.includes(`const ${fk.var_name} = await`));

	// Build child data blocks using helpers
	const { child_import_block, child_fetch_block, child_data_block } = build_child_blocks(
		table_name,
		parent_info,
		child_fn_name,
		child_label,
		var_names,
		child_relative_path,
		child_columns_import_path,
		new_fk_options
	);

	// --- 1. Inject imports (markers or fallback) ---
	if (parent_index.includes(CHILD_IMPORT_START)) {
		// Append inside the existing marker section - replacing the whole
		// section would wipe previously integrated children
		if (!parent_index.includes(`${var_names.child_columns_var} from`)) {
			// Only inject if not already there
			parent_index = parent_index.replace(CHILD_IMPORT_END, `${child_import_block}\n${CHILD_IMPORT_END}`);
			parent_modified = true;
		}
	} else {
		// Fallback: add marker section + imports after last import
		const lines = parent_index.split("\n");
		const last_import = lines.findLastIndex((l) => l.trim().startsWith("import "));
		if (last_import >= 0) {
			// Check if imports are already present (no markers yet)
			const has_child_import = parent_index.includes(`import { ${child_fn_name} } from "./sql"`);
			if (!has_child_import) {
				const import_section = [`${CHILD_IMPORT_START}`, child_import_block, `${CHILD_IMPORT_END}`].join("\n");
				lines.splice(last_import + 1, 0, import_section);
				parent_index = lines.join("\n");
				parent_modified = true;
				console.log(`✓ Added child imports (with markers) to parent index.ts`);
			}
		}
	}

	// --- 2. Inject fetch block (markers or fallback) ---
	if (parent_index.includes(CHILD_FETCH_START)) {
		// Append before the first end marker (the GET edit handler) so
		// earlier children's fetch code is preserved
		const has_fetch = parent_index.includes(`const ${var_names.child_records_var} = await ${child_fn_name}(`);
		if (!has_fetch) {
			parent_index = parent_index.replace(CHILD_FETCH_END, `${child_fetch_block}\n${CHILD_FETCH_END}`);
			parent_modified = true;
		}
	} else {
		// Fallback: add markers before "const bp = base_path();" in the edit handler.
		// This pattern is unique to the GET edit handler (POST handlers use await directly).
		const fetch_anchor = `\n\tconst bp = base_path();\n`;
		if (parent_index.includes(fetch_anchor)) {
			const has_fetch = parent_index.includes(`const ${var_names.child_records_var} = await ${child_fn_name}(`);
			if (!has_fetch) {
				const fetch_section = [`\t${CHILD_FETCH_START}`, child_fetch_block.split("\n").map((l) => `\t${l}`).join("\n"), `\t${CHILD_FETCH_END}`].join("\n");
				parent_index = parent_index.replace(fetch_anchor, `\n${fetch_section}${fetch_anchor}`);
				parent_modified = true;
				console.log(`✓ Added child fetch (with markers) to parent index.ts`);
			}
		}
	}

	// --- 3. Inject data block into render data (markers or fallback) ---
	if (parent_index.includes(CHILD_DATA_START)) {
		// Append before the first end marker (the GET edit render data) so
		// earlier children's data entries are preserved
		const has_data = parent_index.includes(`${var_names.child_records_var},`);
		if (!has_data) {
			parent_index = parent_index.replace(CHILD_DATA_END, `${child_data_block}\n${CHILD_DATA_END}`);
			parent_modified = true;
		}
	} else {
		// Fallback: inject after the action: entity_path(record...) line inside the edit GET handler.
		// "action: entity_path(record." is unique to the edit GET render - it uses
		// the live `record` variable, unlike the create/update handlers.
		const has_data = parent_index.includes(`${var_names.child_records_var},`);
		if (!has_data) {
			const edit_ctx_anchor = `\t\t\taction: entity_path(record.`;
			const anchor_idx = parent_index.indexOf(edit_ctx_anchor);
			const line_end_idx = anchor_idx >= 0 ? parent_index.indexOf("\n", anchor_idx) : -1;
			if (line_end_idx >= 0) {
				const after_action_line = line_end_idx + 1;
				const data_insert = `\t\t\t${CHILD_DATA_START}\n${child_data_block}\n\t\t\t${CHILD_DATA_END}\n`;
				parent_index = parent_index.slice(0, after_action_line) + data_insert + parent_index.slice(after_action_line);
				parent_modified = true;
				console.log(`✓ Added child data (with markers) to parent index.ts`);
			}
		}
	}

	if (parent_modified) {
		await Bun.write(parent_index_path, parent_index);
		console.log(`✓ Updated parent index.ts with child integration for "${table_name}"`);
	}
}

// Build child code blocks

function build_child_blocks(table_name: string, parent_info: ParentInfo, child_fn_name: string, child_label: string, var_names: {
	child_records_var: string;
	child_translated_var: string;
	child_parent_label_var: string;
	child_ui_var: string;
	child_fields_var: string;
	child_columns_var: string;
}, child_relative_path: string, child_columns_import_path: string, child_fk_options: { fn_name: string; var_name: string; }[] = []): { child_import_block: string; child_fetch_block: string; child_data_block: string; } {
	// Import block
	const child_import_lines = [`import { ${child_fn_name} } from "./sql";`, `import { columns as ${var_names.child_columns_var} } from "${child_columns_import_path}";`];
	if (child_fk_options.length > 0) {
		const fk_fn_names = child_fk_options.map((fk) => fk.fn_name).join(", ");
		child_import_lines.push(`import { ${fk_fn_names} } from "./${table_name}/sql";`);
	}
	const child_import_block = child_import_lines.join("\n");

	// Fetch block
	const child_fetch_lines = [
		`const ${var_names.child_records_var} = await ${child_fn_name}(record.${parent_info.route_param});`,
		`const ${var_names.child_translated_var} = (await create_ctx(req, process.cwd() + "/routes/${child_relative_path}")).translations;`,
		`const ${var_names.child_columns_var}_grid_cols = Object.entries(${var_names.child_columns_var}).filter(([k, v]) => k !== "checkbox" && k !== "id" && k !== "${parent_info.fk_column}" && v?.grid !== false).map(([, v]: [string, any]) => typeof v === "string" ? v : v.width).join(" ") + " auto";`,
	];
	for (const fk of child_fk_options) {
		child_fetch_lines.push(`const ${fk.var_name} = await ${fk.fn_name}();`);
	}
	const child_fetch_block = child_fetch_lines.join("\n");

	const child_label_display = capitalize_first(table_name.replace(/_/g, " "));
	const child_label_fallback = child_label !== child_label_display ? child_label : child_label_display;

	// Data block (goes inside render data)
	// child_ui/child_fields come straight from the child route's own ctx.translations - no
	// hardcoded English fallback object. crud_translations.json is already the single source
	// for these defaults and sync_crud_translations() writes them to the DB at generation
	// time; duplicating that text again here as a JS literal would drift the moment either
	// copy changes. If a child route is used before its translations are synced, child_ui.X
	// is undefined until `bun run sync:languages` (or CRUD generation) runs - same as any
	// other DB-driven content in this app, not a special case.
	const child_data_lines = [
		`${var_names.child_records_var},`,
		`${var_names.child_parent_label_var}: ${var_names.child_translated_var}.parent_label || "${child_label_fallback}",`,
		`${var_names.child_ui_var}: ${var_names.child_translated_var}.child_ui,`,
		`${var_names.child_fields_var}: ${var_names.child_translated_var}.child_fields,`,
		`${var_names.child_columns_var},`,
		`${var_names.child_columns_var}_grid_cols,`,
	];
	for (const fk of child_fk_options) {
		child_data_lines.push(`${fk.var_name},`);
	}
	const child_data_block = child_data_lines.join("\n");

	return { child_import_block, child_fetch_block, child_data_block };
}

// Form.ree injection (marker-based)

async function inject_parent_form_marker(parent_form_path: string, child_section: string, child_fields_var: string): Promise<void> {
	let parent_form = await Bun.file(parent_form_path).text();

	if (parent_form.includes(FORM_CHILD_START)) {
		// Update existing marker section
		const regex = new RegExp(`${escape_regex(FORM_CHILD_START)}[\\s\\S]*?${escape_regex(FORM_CHILD_END)}`);

		if (parent_form.includes(`${child_fields_var}:`)) {
			// Already has content -> full replace
			parent_form = parent_form.replace(regex, child_section);
			console.log(`✓ Refreshed inline child list in parent form.ree`);
		} else {
			// Markers exist but no content -> inject inside
			const child_inner = child_section.replace(`${FORM_CHILD_START}\n`, "").replace(`\n${FORM_CHILD_END}`, "");
			parent_form = parent_form.replace(FORM_CHILD_END, `${child_inner}\n${FORM_CHILD_END}`);
			console.log(`✓ Added inline child list to parent form.ree`);
		}
	} else {
		// No markers yet -> inject after </form>
		const form_close = "</form>";
		const form_close_idx = parent_form.indexOf(form_close);
		if (form_close_idx >= 0) {
			parent_form = `${parent_form.slice(0, form_close_idx + form_close.length)}\n${child_section}${parent_form.slice(form_close_idx + form_close.length)}`;
		}
		await Bun.write(parent_form_path, parent_form);
		console.log(`✓ Added inline child list to parent form.ree`);
		return;
	}

	await Bun.write(parent_form_path, parent_form);
}

// Refresh child section (during refresh-fields)

export async function refresh_child_section_in_parent(
	table_name: string,
	parent_info: ParentInfo,
	parent_dir: string,
	fields: FieldDef[],
	v_fields: FieldDef[] | null,
	columns: Record<string, any> | null,
	foreign_keys: ForeignKeyMap,
	route_prefix: string,
	route_dir: string,
): Promise<void> {
	log_step(`Refreshing child section in parent form.ree`);

	const child_section_result = await generate_child_section_html(
		table_name,
		parent_info,
		fields,
		v_fields,
		columns,
		foreign_keys,
		route_prefix,
		"child_records",
		"parent_label",
		"child_ui",
		"child_fields",
		"child_columns"
	);

	await inject_parent_form_refresh_marker(join(parent_dir, "form.ree"), child_section_result.child_section, table_name);
}

async function inject_parent_form_refresh_marker(parent_form_path: string, child_section: string, table_name: string): Promise<void> {
	let parent_form = await Bun.file(parent_form_path).text();

	if (parent_form.includes(FORM_CHILD_START)) {
		const child_section_regex = new RegExp(`<div class="child-list[\\s\\S]*?data-child-section="${table_name}"[\\s\\S]*?</div>\\n*\\n*<!-- Child CRUD dialog -->[\\s\\S]*?${escape_regex(
			FORM_CHILD_END
		)}`);

		if (child_section_regex.test(parent_form)) {
			parent_form = parent_form.replace(child_section_regex, child_section.replace(`${FORM_CHILD_START}\n`, "").replace(`\n${FORM_CHILD_END}`, ""));
		} else {
			const regex = new RegExp(`${escape_regex(FORM_CHILD_START)}[\\s\\S]*?${escape_regex(FORM_CHILD_END)}`);
			parent_form = parent_form.replace(regex, child_section);
		}
	}

	await Bun.write(parent_form_path, parent_form);
}
