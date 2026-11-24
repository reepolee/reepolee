/**
 * Nested CRUD Integration - injects child CRUD into parent files.
 *
 * Uses marker comments where available (form.ree: <!-- GEN:CHILDREN:START/END -->).
 * For index.ts injection, adds markers if not present, falls back to regex for existing files.
 */

import { join, relative } from "node:path";

import { generate_child_section_html } from "./child_section";
import { escape_regex, has_archive_column, log_step } from "./helpers";
import type { FieldDef, ForeignKeyMap, LocalizedFieldMeta, ParentInfo } from "./types";
import { MAIN_APP, MAIN_APP_POSIX } from "$config/paths";
import { ARCHIVE_TIMESTAMP_FIELD } from "$config/db_structure";

// Marker constants

const CHILD_IMPORT_START = "// GEN:CHILD:IMPORT:START";
const CHILD_IMPORT_END = "// GEN:CHILD:IMPORT:END";
const CHILD_FETCH_START = "// GEN:CHILD:FETCH:START";
const CHILD_FETCH_END = "// GEN:CHILD:FETCH:END";
const CHILD_DATA_START = "// GEN:CHILD:DATA:START";
const CHILD_DATA_END = "// GEN:CHILD:DATA:END";
const FORM_CHILD_START = "<!-- GEN:CHILDREN:START -->";
const FORM_CHILD_END = "<!-- GEN:CHILDREN:END -->";

// Public API

export interface NestedChildOptions {
	table_name: string;
	parent_info: ParentInfo;
	parent_dir: string;
	fields: FieldDef[];
	v_fields: FieldDef[] | null;
	/** Physical child-table columns - the only reliable source for archive detection. */
	column_names: string[];
	columns: Record<string, any> | null;
	foreign_keys: ForeignKeyMap;
	route_prefix: string;
	route_dir: string;
	localized_fields: readonly LocalizedFieldMeta[];
}

export async function integrate_nested_child(options: NestedChildOptions): Promise<void> {
	const { table_name, parent_info, parent_dir, fields, v_fields, column_names, columns, foreign_keys, route_prefix, route_dir, localized_fields } = options;
	log_step(`Integrating child "${table_name}" into parent "${parent_info.table}"`);

	const child_fn_name = localized_fields.length > 0 ? "get_children_by_parent" : `get_${table_name}_by_${parent_info.fk_column}`;

	// --- Inject child query function into parent sql.ts ---
	// The child list on the parent's detail page is fetched by a function written
	// into the PARENT's sql.ts, not by the child's own generated sql.ts, so it
	// needs the archive filter applied here as well - miss it and archived
	// children keep showing in the parent's child grid.
	const child_has_archive = has_archive_column(column_names);
	if (localized_fields.length === 0) await inject_parent_sql(parent_dir, table_name, parent_info, v_fields, child_fn_name, child_has_archive);

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
		var_names.child_columns_var,
		localized_fields,
		var_names.child_localization_var,
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
			var_names,
			route_dir,
			child_fk_options,
			localized_fields,
		);
	}

	// --- Inject into parent form.ree ---
	const parent_form_path = join(parent_dir, "form.ree");
	if (await Bun.file(parent_form_path).exists()) { await inject_parent_form_marker(parent_form_path, child_section, table_name); }

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
	child_localization_var: string;
}> {
	const defaults = {
		child_records_var: "child_records",
		child_translated_var: "child_translated",
		child_parent_label_var: "parent_label",
		child_ui_var: "child_ui",
		child_fields_var: "child_fields",
		child_columns_var: "child_columns",
		child_localization_var: "child_localization",
	};

	const disambiguated = {
		child_records_var: `child_${table_name}_records`,
		child_translated_var: `child_${table_name}_translated`,
		child_parent_label_var: `child_${table_name}_parent_label`,
		child_ui_var: `child_${table_name}_ui`,
		child_fields_var: `child_${table_name}_fields`,
		child_columns_var: `child_${table_name}_columns`,
		child_localization_var: `child_${table_name}_localization`,
	};

	try {
		const content = await Bun.file(join(parent_dir, "index.ts")).text();
		const default_columns_import = `import { columns as ${defaults.child_columns_var} } from "./${table_name}/config";`;

		// The columns import uniquely associates the plain aliases with this table,
		// including localized children whose query helper has a generic name.
		if (content.includes(default_columns_import)) { return defaults; }

		// This table was already integrated under the disambiguated names (from
		// a prior run after a second child existed) - keep using them so the
		// re-run's "already imported?" checks match the existing line instead
		// of appending a duplicate under the plain defaults.
		if (content.includes(`const ${disambiguated.child_records_var} = await`)) { return disambiguated; }

		// This table was already integrated under the plain defaults (it was
		// the first/only child at the time) - keep using them for the same reason.
		if (content.includes(`const ${defaults.child_records_var} = await get_${table_name}_by_`)) { return defaults; }

		// Not yet integrated - a different child already claimed the plain
		// defaults, so this one needs disambiguated names to avoid colliding.
		if (content.includes("const child_records = await")) { return disambiguated; }
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
	child_has_archive: boolean,
): Promise<void> {
	const parent_sql_path = join(parent_dir, "sql.ts");
	if (!(await Bun.file(parent_sql_path).exists())) return;

	let parent_sql = await Bun.file(parent_sql_path).text();
	if (parent_sql.includes(child_fn_name)) return;

	const view_source = v_fields ? `v_${table_name}` : table_name;
	const archive_and = child_has_archive ? ` AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL` : "";
	const child_query_fn = [
		"",
		`export async function ${child_fn_name}(parent_id: number | string): Promise<any[]> {`,
		`\ttry {`,
		`\t\treturn await timed_query("${table_name}", "${child_fn_name}", async () => {`,
		`\t\t\tconst records = await db\`SELECT * FROM ${view_source} WHERE ${parent_info.fk_column} = \${parent_id}${archive_and} ORDER BY id ASC\`;`,
		`\t\t\treturn records as any[];`,
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

async function inject_parent_index_marker(parent_index_path: string, table_name: string, parent_info: ParentInfo, child_fn_name: string, var_names: {
	child_records_var: string;
	child_translated_var: string;
	child_parent_label_var: string;
	child_ui_var: string;
	child_fields_var: string;
	child_columns_var: string;
	child_localization_var: string;
}, route_dir: string, child_fk_options: { fn_name: string; var_name: string; }[] = [], localized_fields: readonly LocalizedFieldMeta[] = []): Promise<void> {
	let parent_index = await Bun.file(parent_index_path).text();
	let parent_modified = false;

	// Normalize to forward slashes - on Windows relative() yields backslashes
	// which become escape sequences (\t, \n, ...) inside generated string literals
	const child_relative_path_raw = relative(join(process.cwd(), MAIN_APP), route_dir);
	const child_relative_path = child_relative_path_raw.replaceAll("\\", "/");
	const child_columns_import_path = `./${table_name}/config`;

	// Skip FK option lists the parent handler (or another child) already loads
	const new_fk_options = child_fk_options.filter((fk) => !parent_index.includes(`const ${fk.var_name} = await`));

	// Build child data blocks using helpers
	const { child_import_block, child_fetch_block, child_data_block } = build_child_blocks(
		table_name,
		parent_info,
		child_fn_name,
		var_names,
		child_relative_path,
		child_columns_import_path,
		new_fk_options,
		localized_fields,
	);

	// --- 1. Inject imports (markers or fallback) ---
	if (parent_index.includes(CHILD_IMPORT_START)) {
		const import_start = parent_index.indexOf(CHILD_IMPORT_START) + CHILD_IMPORT_START.length;
		const import_end = parent_index.indexOf(CHILD_IMPORT_END, import_start);
		const import_lines = parent_index.slice(import_start, import_end).split("\n");
		const retained_imports = import_lines.filter((line) =>
			!line.includes(child_fn_name)
			&& !line.includes(`get_${table_name}_by_${parent_info.fk_column}`)
			&& !line.includes(`from "./${table_name}/config"`)
			&& !line.includes(`build_${table_name}_localization_props`)
			&& !line.includes(`get_${table_name}_locale_cookie`)
		);
		const refreshed_imports = `${retained_imports.join("\n").trim()}\n${child_import_block}`.trim();
		parent_index = parent_index.slice(0, import_start) + `\n${refreshed_imports}\n` + parent_index.slice(import_end);
		parent_modified = true;
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
		let search_from = 0;
		while (true) {
			const marker_start = parent_index.indexOf(CHILD_FETCH_START, search_from);
			if (marker_start < 0) break;
			const fetch_start = marker_start + CHILD_FETCH_START.length;
			const fetch_end = parent_index.indexOf(CHILD_FETCH_END, fetch_start);
			if (fetch_end < 0) break;
			const handler_start = parent_index.lastIndexOf("export async function", marker_start);
			const handler_prefix = parent_index.slice(Math.max(0, handler_start), marker_start);
			const record_var = handler_prefix.includes("const existing_record =") ? "existing_record" : "record";
			const scoped_fetch_block = record_var === "record" ? child_fetch_block : child_fetch_block.replaceAll("record.", `${record_var}.`);
			const fetch_lines = parent_index.slice(fetch_start, fetch_end).split("\n");
			const child_vars = [var_names.child_records_var, var_names.child_translated_var, `${var_names.child_columns_var}_grid_cols`, var_names.child_localization_var, `child_${table_name}_records`, `child_${table_name}_translated`, `child_${table_name}_columns_grid_cols`, `child_${table_name}_localization`];
			const child_translation_merge = `ctx.translations = { ...ctx.translations, children: { ...ctx.translations.children, "${table_name}":`;
			const retained_fetch = fetch_lines.filter((line) => !child_vars.some((name) => line.includes(`const ${name} =`) || line.includes(`ctx.translations = { ...${name}, ...ctx.translations };`)) && !line.includes(child_translation_merge));
			const refreshed_fetch = `${retained_fetch.join("\n").trim()}\n${scoped_fetch_block}`.trim();
			parent_index = parent_index.slice(0, fetch_start) + `\n${refreshed_fetch}\n` + parent_index.slice(fetch_end);
			search_from = fetch_start + refreshed_fetch.length + 2 + CHILD_FETCH_END.length;
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
		let search_from = 0;
		while (true) {
			const marker_start = parent_index.indexOf(CHILD_DATA_START, search_from);
			if (marker_start < 0) break;
			const data_start = marker_start + CHILD_DATA_START.length;
			const data_end = parent_index.indexOf(CHILD_DATA_END, data_start);
			if (data_end < 0) break;
			const data_lines = parent_index.slice(data_start, data_end).split("\n");
			const child_vars = [var_names.child_records_var, var_names.child_parent_label_var, var_names.child_ui_var, var_names.child_fields_var, var_names.child_columns_var, `${var_names.child_columns_var}_grid_cols`, var_names.child_localization_var, `child_${table_name}_records`, `child_${table_name}_parent_label`, `child_${table_name}_ui`, `child_${table_name}_fields`, `child_${table_name}_columns`, `child_${table_name}_columns_grid_cols`, `child_${table_name}_localization`];
			const retained_data = data_lines.filter((line) => !child_vars.some((name) => line.trimStart().startsWith(`${name}:`) || line.trim() === `${name},`));
			const refreshed_data = `${retained_data.join("\n").trim()}\n${child_data_block}`.trim();
			parent_index = parent_index.slice(0, data_start) + `\n${refreshed_data}\n` + parent_index.slice(data_end);
			search_from = data_start + refreshed_data.length + 2 + CHILD_DATA_END.length;
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

function build_child_blocks(table_name: string, parent_info: ParentInfo, child_fn_name: string, var_names: {
	child_records_var: string;
	child_translated_var: string;
	child_parent_label_var: string;
	child_ui_var: string;
	child_fields_var: string;
	child_columns_var: string;
	child_localization_var: string;
}, child_relative_path: string, child_columns_import_path: string, child_fk_options: { fn_name: string; var_name: string; }[] = [], localized_fields: readonly LocalizedFieldMeta[] = []): { child_import_block: string; child_fetch_block: string; child_data_block: string; } {
	const localized = localized_fields.length > 0;
	// Import block
	const child_sql_path = localized ? `./${table_name}/sql` : "./sql";
	const child_import_lines = [`import { ${child_fn_name} } from "${child_sql_path}";`, `import { columns as ${var_names.child_columns_var} } from "${child_columns_import_path}";`];
	if (localized) {
		child_import_lines.push(`import { build_localization_props as build_${table_name}_localization_props } from "$lib/localized_form";`);
		child_import_lines.push(`import { get_cookie as get_${table_name}_locale_cookie } from "$lib/cookies";`);
	}
	if (child_fk_options.length > 0) {
		const fk_fn_names = child_fk_options.map((fk) => fk.fn_name).join(", ");
		child_import_lines.push(`import { ${fk_fn_names} } from "./${table_name}/sql";`);
	}
	const child_import_block = child_import_lines.join("\n");

	// Fetch block
	const child_fetch_lines = [
		`const ${var_names.child_records_var} = await ${child_fn_name}(record.${parent_info.route_param}${localized ? ", ctx.locale" : ""});`,
		`const ${var_names.child_translated_var} = (await create_ctx(req, process.cwd() + "/${MAIN_APP_POSIX}/${child_relative_path}")).translations;`,
		`ctx.translations = { ...ctx.translations, children: { ...ctx.translations.children, "${table_name}": ${var_names.child_translated_var} } };`,
		`const ${var_names.child_columns_var}_grid_cols = Object.entries(${var_names.child_columns_var}).filter(([k, v]) => k !== "checkbox" && k !== "id" && k !== "${parent_info.fk_column}" && v?.grid !== false).map(([, v]: [string, any]) => typeof v === "string" ? v : v.width).join(" ") + " auto";`,
	];
	if (localized) {
		const localized_config = localized_fields.map((field) => ({ field_name: field.field_name, label: field.label, input_type: field.input_type, upload_folder: field.upload_folder }));
		child_fetch_lines.push(`const ${var_names.child_localization_var} = build_${table_name}_localization_props({ fields: ${JSON.stringify(localized_config)}, record: {}, copy_action: "", preferred_locale: get_${table_name}_locale_cookie(req, "preferred_locale") ?? undefined });`);
	}
	for (const fk of child_fk_options) {
		child_fetch_lines.push(`const ${fk.var_name} = await ${fk.fn_name}();`);
	}
	const child_fetch_block = child_fetch_lines.join("\n");

	// Data block (goes inside render data). Child translations are merged into
	// ctx.translations above under its own child table key, so child sections
	// never overwrite another child's labels or UI text.
	const child_data_lines = [
		`${var_names.child_records_var},`,
		`${var_names.child_columns_var},`,
		`${var_names.child_columns_var}_grid_cols,`,
	];
	if (localized) child_data_lines.push(`${var_names.child_localization_var},`);
	for (const fk of child_fk_options) {
		child_data_lines.push(`${fk.var_name},`);
	}
	const child_data_block = child_data_lines.join("\n");

	return { child_import_block, child_fetch_block, child_data_block };
}

// Form.ree injection (marker-based)

async function inject_parent_form_marker(parent_form_path: string, child_section: string, table_name: string): Promise<void> {
	let parent_form = await Bun.file(parent_form_path).text();

	if (parent_form.includes(FORM_CHILD_START)) {
		const start_idx = parent_form.indexOf(FORM_CHILD_START);
		const end_idx = parent_form.indexOf(FORM_CHILD_END, start_idx) + FORM_CHILD_END.length;
		const marker_section = parent_form.slice(start_idx, end_idx);
		// Identify this child's own block by its data-child-section attribute -
		// checking for rendered content in general (e.g. child_fields_var, which
		// only appears in index.ts) would never match here and silently append
		// a duplicate copy on every regeneration instead of replacing it.
		const child_marker = `data-child-section="${table_name}"`;
		const marker_pos = marker_section.indexOf(child_marker);

		if (marker_pos >= 0) {
			// This child's block already exists - isolate it by its enclosing
			// {#if record.id} ... {/if}: walk back to that block's opening tag,
			// then forward to the next sibling block's opening tag (or the
			// section end marker if this is the last/only child) to find where
			// it closes, so only this child's own content gets replaced.
			const block_open = "{#if record.id}";
			const block_start = marker_section.lastIndexOf(block_open, marker_pos);
			const next_block_start = marker_section.indexOf(block_open, marker_pos + child_marker.length);
			const block_end = next_block_start >= 0 ? next_block_start : marker_section.length - FORM_CHILD_END.length;

			if (block_start >= 0) {
				const child_inner = child_section.replace(`${FORM_CHILD_START}\n`, "").replace(`\n${FORM_CHILD_END}`, "");
				const new_marker_section = marker_section.slice(0, block_start) + child_inner + "\n" + marker_section.slice(block_end);
				parent_form = parent_form.slice(0, start_idx) + new_marker_section + parent_form.slice(end_idx);
				console.log(`✓ Refreshed inline child list for "${table_name}" in parent form.ree`);
			} else {
				// Couldn't isolate this child's exact block - fall back to a full-section replace
				parent_form = parent_form.slice(0, start_idx) + child_section + parent_form.slice(end_idx);
				console.log(`✓ Refreshed inline child list in parent form.ree`);
			}
		} else {
			// Markers exist but this child has no content yet -> append inside
			const child_inner = child_section.replace(`${FORM_CHILD_START}\n`, "").replace(`\n${FORM_CHILD_END}`, "");
			parent_form = parent_form.replace(FORM_CHILD_END, `${child_inner}\n${FORM_CHILD_END}`);
			console.log(`✓ Added inline child list for "${table_name}" to parent form.ree`);
		}
	} else {
		// No markers yet -> create the named details area inside the form.
		const form_close = "</form>";
		const form_close_idx = parent_form.indexOf(form_close);
		if (form_close_idx >= 0) {
			const details_area = `<aside class="col-span-full grid gap-4 empty:hidden" data-form-details>\n${child_section}\n</aside>\n`;
			parent_form = `${parent_form.slice(0, form_close_idx)}${details_area}${parent_form.slice(form_close_idx)}`;
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
	localized_fields: readonly LocalizedFieldMeta[] = [],
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
		"child_columns",
		localized_fields,
		"child_localization",
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
