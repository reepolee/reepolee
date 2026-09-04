import { pluralize_english } from "$generator/naming";

import { get_studio_tables, render_view } from "./model";
import type { Dialect, StudioColumn, StudioFile, StudioTable } from "./types";

export interface SchemaAdaptationSummary {
	tables_adapted: string[];
	references_updated: string[];
	views_adapted: string[];
}

/** An `*_id` column with no table to point at - a naming problem only the operator can resolve. */
export interface DanglingIdColumn {
	table: string;
	column: string;
	/** Table the generator would infer from the column name, which does not exist. */
	expected_table: string;
	/** True when the column type is integer, which hints at a counter rather than a code. */
	is_integer: boolean;
}

const INTEGER_TYPE = /^(INT|INTEGER|BIGINT|SMALLINT|MEDIUMINT|TINYINT)\b/i;
const DISPLAY_SOURCE_PRIORITY = ["name", "title", "label"];

/**
 * Find `*_id` columns whose target table does not exist.
 *
 * The generator treats any `*_id` column as a foreign key and infers the target
 * by pluralizing the stem (`round_id` -> `rounds`). When that table is absent the
 * column is not a foreign key at all - it is a plain number or code that was named
 * `_id` by mistake, usually in a schema imported from another project. The
 * generator only discovers this late, during CRUD generation, as
 * `Table "rounds" is missing from the DDL cache.`
 *
 * This is reported, never auto-corrected: renaming a column changes the schema's
 * meaning and any application code reading it, so the operator decides.
 */
export function find_dangling_id_columns(model: StudioFile): DanglingIdColumn[] {
	const tables = get_studio_tables(model);
	const table_names = new Set(tables.map((table) => table.name.toLowerCase()));
	const dangling: DanglingIdColumn[] = [];

	for (const table of tables) {
		for (const column of table.columns) {
			const column_lower = column.name.toLowerCase();
			if (!column_lower.endsWith("_id")) continue;
			if (column_lower === "id") continue;

			// An explicit REFERENCES clause names its target, so nothing is inferred.
			if (column.references) continue;

			const stem = column_lower.slice(0, -3);
			if (resolves_to_table(stem, table_names)) continue;

			dangling.push({
				table: table.name,
				column: column.name,
				expected_table: pluralize_english(stem),
				is_integer: INTEGER_TYPE.test(column.type_string),
			});
		}
	}

	return dangling;
}

/**
 * Whether an `*_id` stem resolves to a real table, mirroring the generator's
 * inference: an exact name match, the pluralized stem, or a numbered stem
 * (`team_1_id` -> `teams`) as produced by multi-FK tables like `schedule`.
 */
function resolves_to_table(stem: string, table_names: Set<string>): boolean {
	if (table_names.has(stem)) return true;
	if (table_names.has(pluralize_english(stem))) return true;

	// `team_1_id` / `table_2_id` - strip the positional suffix and retry.
	const numbered = /^(.*)_\d+$/.exec(stem);
	if (numbered) {
		const base = numbered[1]!;
		if (table_names.has(base)) return true;
		if (table_names.has(pluralize_english(base))) return true;
	}
	return false;
}

/**
 * Adapt every table in the file to the standard Reepolee DDL shape:
 * integer `id` primary key (a non-integer PK is renamed to `code` and kept
 * as a unique natural key), plus mandatory `display`, `created_at`, and
 * `updated_at` columns. Runs over the whole file in two passes so that
 * incoming FK columns/references can be repointed at a renamed PK before
 * any table is mutated.
 */
export function adapt_schema_to_standard(model: StudioFile): SchemaAdaptationSummary {
	const tables = get_studio_tables(model);
	const pk_renames = new Map<string, string>(); // table_name -> old PK column name (now "code")

	for (const table of tables) {
		const pk_column = table.columns.find((column) => column.is_primary_key);
		if (pk_column && pk_column.name !== "id" && !INTEGER_TYPE.test(pk_column.type_string)) {
			pk_renames.set(table.name, pk_column.name);
		}
	}

	const tables_adapted: string[] = [];
	for (const table of tables) {
		const changed = adapt_table_columns(table, model.dialect, pk_renames.has(table.name));
		if (changed) tables_adapted.push(table.name);
	}

	const references_updated: string[] = [];
	for (const table of tables) {
		for (const column of table.columns) {
			if (!column.references) continue;
			const old_pk_name = pk_renames.get(column.references.table);
			if (old_pk_name && column.references.column === old_pk_name) {
				column.references = { ...column.references, column: "id" };
				references_updated.push(`${table.name}.${column.name} -> ${column.references.table}.id`);
			}
		}
		for (const foreign_key of table.table_foreign_keys) {
			const old_pk_name = pk_renames.get(foreign_key.ref_table);
			if (old_pk_name && foreign_key.ref_column === old_pk_name) {
				foreign_key.ref_column = "id";
				references_updated.push(`${table.name}.${foreign_key.column} -> ${foreign_key.ref_table}.id`);
			}
		}
	}

	for (const statement of model.statements) {
		if (statement.table && tables_adapted.includes(statement.table.name)) statement.dirty = true;
	}

	const views_adapted = adapt_views(model);

	return { tables_adapted, references_updated, views_adapted };
}

/**
 * Add a `display` column to every view that lacks one. Views are stored as raw
 * text (the parser does not model their columns), so the projection is rewritten
 * textually: a `CAST(<source> AS TEXT) AS display` item is appended to the outer
 * SELECT list. The cast is mandatory - SQLite reports no declared type for a bare
 * expression column, which fails the generator's string-compatibility check.
 */
function adapt_views(model: StudioFile): string[] {
	const views_adapted: string[] = [];
	const table_names = new Set(get_studio_tables(model).map((table) => table.name));

	for (const statement of model.statements) {
		if (statement.kind !== "create_view") continue;

		// A `v_<table>` companion view enters the generator's stricter contract:
		// it must expose `<stem>_display` for every FK column it projects. Text
		// patching cannot satisfy that (the FK columns may arrive via `t.*`), so
		// the view is regenerated from the table, which emits the joins and the
		// `_display` columns. Views with no matching table are reporting views -
		// they only need `display`, which is patched in below.
		const companion_table = companion_table_name(statement.object_name, table_names);
		if (companion_table) {
			statement.text = render_companion_view(model, companion_table);
			views_adapted.push(statement.object_name);
			continue;
		}

		const rewritten = add_display_to_view(statement.text);
		if (!rewritten) continue;
		statement.text = rewritten;
		views_adapted.push(statement.object_name);
	}

	return views_adapted;
}

/** Regenerate a companion view from its table, so FK `_display` columns and joins are emitted. */
function render_companion_view(model: StudioFile, table_name: string): string {
	const tables = get_studio_tables(model);
	const table = tables.find((candidate) => candidate.name === table_name)!;
	return render_view(model, table);
}

/** Table this view is the `v_<table>` companion of, or null when it is a standalone view. */
function companion_table_name(view_name: string, table_names: Set<string>): string | null {
	if (!view_name.startsWith("v_")) return null;
	const candidate = view_name.slice(2);
	return table_names.has(candidate) ? candidate : null;
}

/** Rewrite one CREATE VIEW to expose `display`. Returns null when no change is needed or possible. */
function add_display_to_view(text: string): string | null {
	const select_start = find_outer_select(text);
	if (select_start === -1) return null;

	const select_end = find_select_list_end(text, select_start);
	if (select_end === -1) return null;

	const select_list = text.slice(select_start, select_end);
	if (has_display_item(select_list)) return null;

	const source = find_view_display_source(select_list);
	if (!source) return null;

	const indent = detect_select_indent(select_list);
	const trimmed_list = select_list.replace(/\s+$/, "");
	const separator = trimmed_list.endsWith(",") ? "" : ",";
	const display_item = `${separator}\n${indent}CAST(${source} AS TEXT) AS display`;
	return `${text.slice(0, select_start)}${trimmed_list}${display_item}${text.slice(select_end)}`;
}

/** Index just past the view's outer SELECT keyword, skipping any leading CTE or parenthesized prefix. */
function find_outer_select(text: string): number {
	const as_match = /\bAS\b/i.exec(text);
	if (!as_match) return -1;
	const after_as = as_match.index + as_match[0].length;
	const select_match = /\bSELECT\b(\s+(DISTINCT|ALL)\b)?/i.exec(text.slice(after_as));
	if (!select_match) return -1;
	return after_as + select_match.index + select_match[0].length;
}

/** Index of the top-level FROM that terminates the outer SELECT list. */
function find_select_list_end(text: string, select_start: number): number {
	let depth = 0;
	let index = select_start;

	while (index < text.length) {
		const char = text[index]!;
		if (char === "'") {
			index = skip_quoted(text, index);
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (depth === 0 && /\s/.test(char)) {
			const from_match = /^\s+FROM\b/i.exec(text.slice(index));
			if (from_match) return index;
		}
		index++;
	}
	return -1;
}

/** Index just past a single-quoted literal starting at `index`. */
function skip_quoted(text: string, index: number): number {
	let cursor = index + 1;
	while (cursor < text.length) {
		if (text[cursor] === "'") {
			if (text[cursor + 1] === "'") { cursor += 2; continue; }
			return cursor + 1;
		}
		cursor++;
	}
	return cursor;
}

/** True when the select list already projects a column aliased (or named) `display`. */
function has_display_item(select_list: string): boolean {
	const items = split_top_level_items(select_list);
	for (const item of items) {
		if (/\bAS\s+["`]?display["`]?\s*$/i.test(item.trim())) return true;
		if (/(^|\.)["`]?display["`]?\s*$/i.test(item.trim())) return true;
	}
	return false;
}

/**
 * Pick the expression the view's `display` is built from: the first select item
 * whose output name matches the display-source priority, else the first item that
 * is a plain column reference and not an id/star.
 */
function find_view_display_source(select_list: string): string | null {
	const items = split_top_level_items(select_list);
	const named: { name: string; expr: string; }[] = [];

	for (const item of items) {
		const expr = item.trim();
		if (!expr || expr.endsWith("*")) continue;
		const alias_match = /\bAS\s+["`]?(\w+)["`]?\s*$/i.exec(expr);
		const name = alias_match ? alias_match[1]! : last_identifier(expr);
		if (!name) continue;
		named.push({ name: name.toLowerCase(), expr: alias_match ? expr.slice(0, alias_match.index).trim() : expr });
	}

	for (const candidate of DISPLAY_SOURCE_PRIORITY) {
		const match = named.find((item) => item.name === candidate);
		if (match) return match.expr;
	}
	const usable = named.filter((item) => item.name !== "id" && !item.name.endsWith("_id"));
	const plain = usable.find((item) => /^[\w.]+$/.test(item.expr));
	if (plain) return plain.expr;
	// Aggregate-only views (every item wrapped in MAX/CASE) have no plain column.
	// Repeat the first usable item's expression - SQLite cannot reference another
	// select item's alias from within the same select list.
	const aliased = usable.find((item) => item.expr !== "");
	return aliased ? aliased.expr : null;
}

/** Trailing identifier of a select item, e.g. "t.title" -> "title". Null when the item is an expression. */
function last_identifier(expr: string): string | null {
	const match = /^[\w.]+$/.exec(expr.trim());
	if (!match) return null;
	const parts = expr.trim().split(".");
	return parts[parts.length - 1] ?? null;
}

/** Split a select list on top-level commas, ignoring commas inside parens or quotes. */
function split_top_level_items(select_list: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	let index = 0;

	while (index < select_list.length) {
		const char = select_list[index]!;
		if (char === "'") {
			index = skip_quoted(select_list, index);
			continue;
		}
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === "," && depth === 0) {
			items.push(select_list.slice(start, index));
			start = index + 1;
		}
		index++;
	}
	items.push(select_list.slice(start));
	return items;
}

/** Indentation used by the view's select items, so the appended item lines up. */
function detect_select_indent(select_list: string): string {
	const match = /\n([ \t]+)\S/.exec(select_list);
	return match ? match[1]! : "    ";
}

/** Adapt one table's columns in place. Returns true if anything changed. */
function adapt_table_columns(table: StudioTable, dialect: Dialect, rename_pk_to_code: boolean): boolean {
	let changed = false;

	if (rename_pk_to_code) {
		const pk_column = table.columns.find((column) => column.is_primary_key)!;
		pk_column.name = "code";
		pk_column.is_primary_key = false;
		pk_column.is_unique = true;
		pk_column.name_pad = undefined;
		pk_column.modifier_order = pk_column.modifier_order.filter((key) => key !== "primary_key");
		if (!pk_column.modifier_order.includes("unique")) pk_column.modifier_order.push("unique");
		table.columns.unshift(make_id_column(dialect));
		changed = true;
	} else if (!table.columns.some((column) => column.name === "id")) {
		table.columns.unshift(make_id_column(dialect));
		changed = true;
	}

	if (!table.columns.some((column) => column.name === "display")) {
		const source = find_display_source(table);
		table.columns.push(make_display_column(dialect, source));
		changed = true;
	}

	if (!table.columns.some((column) => column.name === "created_at")) {
		table.columns.push(make_timestamp_column("created_at", dialect));
		changed = true;
	}

	if (!table.columns.some((column) => column.name === "updated_at")) {
		table.columns.push(make_timestamp_column("updated_at", dialect));
		changed = true;
	}

	return changed;
}

/** First column matching the display-source priority (name, title, label), else the first non-id/code string column. */
function find_display_source(table: StudioTable): string {
	for (const candidate of DISPLAY_SOURCE_PRIORITY) {
		if (table.columns.some((column) => column.name === candidate)) return candidate;
	}
	const string_column = table.columns.find((column) => !["id", "code"].includes(column.name) && /CHAR|TEXT/i.test(column.type_string));
	return string_column?.name ?? "id";
}

function make_id_column(dialect: Dialect): StudioColumn {
	if (dialect === "mysql") {
		return {
			name: "id",
			type_string: "INT UNSIGNED",
			domain_type: "pk_id",
			nullability: "not_null",
			default_value: null,
			is_primary_key: true,
			is_auto_increment: true,
			is_unique: false,
			is_generated: false,
			on_update_current_timestamp: false,
			modifier_order: ["nullability", "auto_increment", "primary_key"],
		};
	}
	return {
		name: "id",
		type_string: "INTEGER",
		domain_type: "pk_id",
		nullability: "unspecified",
		default_value: null,
		is_primary_key: true,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: ["primary_key"],
	};
}

function make_display_column(dialect: Dialect, source: string): StudioColumn {
	const type_string = dialect === "mysql" ? "VARCHAR(255)" : "TEXT";
	return {
		name: "display",
		type_string,
		domain_type: "varchar",
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: true,
		generated_expr: source,
		generated_kind: "VIRTUAL",
		generated_as_pad: " ",
		on_update_current_timestamp: false,
		modifier_order: ["generated"],
	};
}

function make_timestamp_column(name: "created_at" | "updated_at", dialect: Dialect): StudioColumn {
	const on_update = name === "updated_at" && dialect === "mysql";
	const modifier_order = dialect === "mysql"
		? (on_update ? ["nullability", "default", "on_update"] as const : ["nullability", "default"] as const)
		: ["default"] as const;
	return {
		name,
		type_string: "TIMESTAMP",
		domain_type: "timestamp",
		nullability: dialect === "mysql" ? "not_null" : "unspecified",
		default_value: "CURRENT_TIMESTAMP",
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: on_update,
		modifier_order: [...modifier_order],
	};
}
