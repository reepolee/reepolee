#!/usr/bin/env bun
/**
 * JSON to SQL table - convert a JSON array of objects into a new table,
 * writing a paired sql/mysql/NN-{slug}.sql + sql/sqlite/NN-{slug}.sql file
 * with system columns (id, display, created_at, updated_at) and seed INSERT
 * statements for the rows found in the JSON.
 *
 * Input JSON shapes accepted:
 * - { "data": [ {...}, {...} ] }   (any single array-valued top-level key)
 * - [ {...}, {...} ]               (bare array)
 *
 * Exports:
 * - infer_columns()       - core type-inference logic (pure, testable)
 * - build_mysql_sql()     - render the MySQL .sql file body
 * - build_sqlite_sql()    - render the SQLite .sql file body
 * - convert_json_to_sql() - read a JSON file, infer schema, write both files
 * - run_json_to_sql()     - interactive reeman flow (file picker + prompts)
 *
 * The generated SQL is a starting point, not a final schema - review it
 * before applying (foreign keys, uniqueness, view joins are not inferred).
 */

import { isAbsolute, join, relative } from "node:path";

import { ask, color, confirm, dim, GREEN, header, select_from_list, show_cli_tip, YELLOW } from "./ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ColumnType = "integer" | "float" | "boolean" | "string" | "text" | "json";

export interface InferredColumn {
	name: string;
	type: ColumnType;
	nullable: boolean;
	max_length: number; // only meaningful for "string"
}

export interface InferredSchema {
	columns: InferredColumn[];
	pk_from_data: boolean; // true when every row has a unique numeric "id"
	display_column: string; // name of the column used for the `display` generated column
	soft_fk_columns: string[]; // columns matching `{x}_id` other than the PK
}

// ---------------------------------------------------------------------------
// Row extraction - accept { data: [...] }, any single array-valued key, or a
// bare top-level array.
// ---------------------------------------------------------------------------

export function extract_rows(parsed: unknown): Record<string, unknown>[] {
	if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];

	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];

		const array_values = Object.values(obj).filter((v) => Array.isArray(v));
		if (array_values.length === 1) return array_values[0] as Record<string, unknown>[];
	}

	throw new Error(`Could not find a row array. Expected { "data": [...] } or a bare [...] array.`);
}

// ---------------------------------------------------------------------------
// Schema inference
// ---------------------------------------------------------------------------

function bucket_length(max_len: number): number {
	const buckets = [15, 30, 50, 100, 191, 255];
	for (const b of buckets) { if (max_len <= b) return b; }
	return 255; // longer values fall through to TEXT, this bucket is unused then
}

function infer_value_kind(value: unknown): ColumnType | "null" {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
	if (typeof value === "string") return "string";
	return "json"; // object or array
}

export function infer_columns(rows: Record<string, unknown>[]): InferredSchema {
	if (rows.length === 0) throw new Error("No rows found - the JSON array is empty.");

	// Preserve first-seen key order across all rows.
	const ordered_keys: string[] = [];
	const seen_keys = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen_keys.has(key)) {
				seen_keys.add(key);
				ordered_keys.push(key);
			}
		}
	}

	// "id" is handled separately as the primary key when every row has a
	// unique integer id; otherwise a synthetic auto-increment id is used and
	// any "id" field in the data is treated like any other column.
	const id_values = rows.map((r) => r.id);
	const pk_from_data =
		ordered_keys.includes("id") &&
		id_values.every((v) => typeof v === "number" && Number.isInteger(v)) &&
		new Set(id_values).size === rows.length;

	const data_keys = ordered_keys.filter((k) => !(pk_from_data && k === "id"));

	const columns: InferredColumn[] = data_keys.map((key) => {
		let nullable = false;
		let has_int = false;
		let has_float = false;
		let has_bool = false;
		let has_string = false;
		let has_json = false;
		let max_length = 0;

		for (const row of rows) {
			const has_key = Object.prototype.hasOwnProperty.call(row, key);
			const kind = has_key ? infer_value_kind(row[key]) : "null";
			if (kind === "null") { nullable = true; continue; }
			if (kind === "integer") has_int = true;
			else if (kind === "float") has_float = true;
			else if (kind === "boolean") has_bool = true;
			else if (kind === "string") {
				has_string = true;
				max_length = Math.max(max_length, String(row[key]).length);
			} else if (kind === "json") { has_json = true; }
		}

		// Mixed types collapse to the most permissive representation:
		// json > string/text > float > integer > boolean.
		let type: ColumnType;
		if (has_json) type = "json";
		else if (has_string) type = max_length > 255 ? "text" : "string";
		else if (has_float) type = "float";
		else if (has_int) type = "integer";
		else if (has_bool) type = "boolean";
		else type = "string"; // every value was null - default to a nullable string

		return { name: key, type, nullable, max_length };
	});

	const display_column =
		["name", "title", "display", "label"].find((c) => columns.some((col) => col.name === c)) ??
		columns.find((c) => c.type === "string" || c.type === "text")?.name ??
		(pk_from_data ? "id" : columns[0]?.name ?? "id");

	const soft_fk_columns = data_keys.filter((k) => /^[a-z0-9]+_id$/.test(k));

	return { columns, pk_from_data, display_column, soft_fk_columns };
}

// ---------------------------------------------------------------------------
// SQL rendering helpers
// ---------------------------------------------------------------------------

function sql_escape(value: string): string {
	return value.replace(/'/g, "''");
}

function sql_literal(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "boolean") return value ? "1" : "0";
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return `'${sql_escape(value)}'`;
	return `'${sql_escape(JSON.stringify(value))}'`;
}

function mysql_column_type(col: InferredColumn): string {
	switch (col.type) {
		case "integer": return "INT";
		case "float": return "DECIMAL(18,2)";
		case "boolean": return "TINYINT(1)";
		case "string": return `VARCHAR(${bucket_length(col.max_length)})`;
		case "text": return "TEXT";
		case "json": return "JSON";
	}
}

function sqlite_column_type(col: InferredColumn): string {
	switch (col.type) {
		case "integer": return "INTEGER";
		case "float": return "REAL";
		case "boolean": return "INTEGER";
		case "string": return "TEXT";
		case "text": return "TEXT";
		case "json": return "JSON";
	}
}

function default_literal(col: InferredColumn): string {
	if (col.type === "integer" || col.type === "float" || col.type === "boolean") return "0";
	return "''";
}

export interface BuildSqlOptions {
	table: string;
	columns: InferredColumn[];
	pk_from_data: boolean;
	display_column: string;
	soft_fk_columns: string[];
	rows: Record<string, unknown>[];
}

function column_name_width(columns: InferredColumn[]): number {
	const all_names = ["id", ...columns.map((c) => c.name), "display", "created_at", "updated_at"];
	return Math.max(...all_names.map((n) => n.length)) + 2;
}

export function build_mysql_sql(opts: BuildSqlOptions): string {
	const { table, columns, pk_from_data, display_column, soft_fk_columns, rows } = opts;
	const name_w = column_name_width(columns);

	const lines: string[] = [`DROP TABLE IF EXISTS ${table};`, "", `CREATE TABLE ${table} (`];

	const col_lines: string[] = [];
	col_lines.push(`    ${"id".padEnd(name_w)}INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU'`);
	for (const col of columns) {
		const sql_type = mysql_column_type(col);
		const nullability = col.nullable ? "DEFAULT NULL" : `NOT NULL DEFAULT ${default_literal(col)}`;
		col_lines.push(`    ${col.name.padEnd(name_w)}${sql_type} ${nullability} COMMENT 'ICU'`);
	}
	const display_ref = display_column === "id" ? "id" : display_column;
	col_lines.push(`    ${"display".padEnd(name_w)}VARCHAR(255) GENERATED ALWAYS AS (${display_ref}) VIRTUAL`);
	col_lines.push(`    ${"created_at".padEnd(name_w)}TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP`);
	col_lines.push(`    ${"updated_at".padEnd(name_w)}TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);

	lines.push(col_lines.join(",\n"));
	lines.push(`) COMMENT '';`);
	lines.push("");

	for (const fk of soft_fk_columns) { lines.push(`CREATE INDEX ${table}_${fk} ON ${table}(${fk});`); }
	if (soft_fk_columns.length > 0) {
		lines.push("");
		lines.push(`-- ${soft_fk_columns.join(", ")} look like foreign keys but the target table is`);
		lines.push(`-- unknown from JSON alone - add a v_${table} view manually once confirmed.`);
	}

	if (rows.length > 0) {
		lines.push("");
		lines.push(build_insert_block(table, columns, pk_from_data, rows, "INSERT IGNORE INTO"));
	}

	return `${lines.join("\n")}\n`;
}

export function build_sqlite_sql(opts: BuildSqlOptions): string {
	const { table, columns, pk_from_data, display_column, soft_fk_columns, rows } = opts;
	const name_w = column_name_width(columns);

	const lines: string[] = [`DROP TABLE IF EXISTS ${table};`, "", `CREATE TABLE ${table} (`];

	const col_lines: string[] = [];
	col_lines.push(`    ${"id".padEnd(name_w)}INTEGER   PRIMARY KEY`);
	for (const col of columns) {
		const sql_type = sqlite_column_type(col);
		const nullability = col.nullable ? "" : `NOT NULL DEFAULT ${default_literal(col)}`;
		col_lines.push(`    ${col.name.padEnd(name_w)}${sql_type} ${nullability}`.trimEnd());
	}
	const display_ref = display_column === "id" ? "id" : display_column;
	col_lines.push(`    ${"display".padEnd(name_w)}TEXT      GENERATED ALWAYS AS (${display_ref}) VIRTUAL`);
	col_lines.push(`    ${"created_at".padEnd(name_w)}TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
	col_lines.push(`    ${"updated_at".padEnd(name_w)}TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

	lines.push(col_lines.join(",\n"));
	lines.push(");");
	lines.push("");

	for (const fk of soft_fk_columns) { lines.push(`CREATE INDEX ${table}_${fk} ON ${table}(${fk});`); }

	lines.push(
		`CREATE TRIGGER ${table}_updated_at_trigger AFTER UPDATE ON ${table} FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE ${table} SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;`
	);

	if (soft_fk_columns.length > 0) {
		lines.push("");
		lines.push(`-- ${soft_fk_columns.join(", ")} look like foreign keys but the target table is`);
		lines.push(`-- unknown from JSON alone - add REFERENCES manually once confirmed.`);
	}

	if (rows.length > 0) {
		lines.push("");
		lines.push(build_insert_block(table, columns, pk_from_data, rows, "INSERT OR IGNORE INTO"));
	}

	return `${lines.join("\n")}\n`;
}

function build_insert_block(
	table: string,
	columns: InferredColumn[],
	pk_from_data: boolean,
	rows: Record<string, unknown>[],
	insert_verb: string
): string {
	const col_names = pk_from_data ? ["id", ...columns.map((c) => c.name)] : columns.map((c) => c.name);
	const value_rows = rows.map((row) => {
		const values = col_names.map((name) => sql_literal(row[name]));
		return `(${values.join(",")})`;
	});
	return `${insert_verb} ${table} (${col_names.join(", ")}) VALUES\n${value_rows.join(",\n")};`;
}

// ---------------------------------------------------------------------------
// File numbering - continue the existing sql/mysql NN- prefix sequence.
// ---------------------------------------------------------------------------

export async function next_sql_number(sql_mysql_dir: string): Promise<string> {
	let max_num = 0;
	try {
		const glob = new Bun.Glob("*.sql");
		for await (const file of glob.scan({ cwd: sql_mysql_dir, onlyFiles: true })) {
			const match = file.match(/^(\d+)-/);
			if (match) max_num = Math.max(max_num, parseInt(match[1]!, 10));
		}
	} catch {
		// sql/mysql/ doesn't exist yet - start at 1
	}
	const next = max_num + 1;
	return String(next).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Table/slug name helpers
// ---------------------------------------------------------------------------

const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export function slugify_filename(path: string): string {
	const base = path.split("/").pop()!.replace(/\.json$/i, "");
	const snake = base
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.toLowerCase()
		.replace(/^_+|_+$/g, "");
	return snake || "data";
}

export function validate_name(name: string, label: string): string {
	const trimmed = name.trim();
	if (!TABLE_NAME_PATTERN.test(trimmed)) { throw new Error(`${label} must be snake_case and start with a letter.`); }
	return trimmed;
}

export function validate_slug(slug: string): string {
	const trimmed = slug.trim();
	if (!SLUG_PATTERN.test(trimmed)) { throw new Error(`File slug must start with a letter and contain only lowercase letters, numbers, and hyphens.`); }
	return trimmed;
}

// ---------------------------------------------------------------------------
// Core conversion - read JSON, infer schema, write the paired SQL files.
// ---------------------------------------------------------------------------

export interface ConvertResult {
	mysql_path: string;
	sqlite_path: string;
	schema: InferredSchema;
	row_count: number;
}

export async function convert_json_to_sql(
	json_path: string,
	table: string,
	options: { slug?: string; project_root?: string } = {}
): Promise<ConvertResult> {
	const validated_table = validate_name(table, "Table name");
	const project_root = options.project_root ?? process.cwd();
	const slug = validate_slug(options.slug ?? validated_table);

	const input_path = isAbsolute(json_path) ? json_path : join(project_root, json_path);
	const file = Bun.file(input_path);
	if (!(await file.exists())) throw new Error(`File not found: ${json_path}`);

	const parsed = JSON.parse(await file.text());
	const rows = extract_rows(parsed);
	const schema = infer_columns(rows);

	const number = await next_sql_number(join(project_root, "sql", "mysql"));
	const filename = `${number}-${slug}.sql`;
	const mysql_path = join("sql", "mysql", filename);
	const sqlite_path = join("sql", "sqlite", filename);

	const build_opts: BuildSqlOptions = {
		table: validated_table,
		columns: schema.columns,
		pk_from_data: schema.pk_from_data,
		display_column: schema.display_column,
		soft_fk_columns: schema.soft_fk_columns,
		rows,
	};

	await Bun.write(join(project_root, mysql_path), build_mysql_sql(build_opts));
	await Bun.write(join(project_root, sqlite_path), build_sqlite_sql(build_opts));

	return { mysql_path, sqlite_path, schema, row_count: rows.length };
}

// ---------------------------------------------------------------------------
// Interactive reeman flow
// ---------------------------------------------------------------------------

async function pick_json_file(project_root: string): Promise<string | null> {
	const json_files: string[] = [];
	const glob = new Bun.Glob("**/*.json");
	const skip_names = new Set(["package.json", "package-lock.json", "tsconfig.json"]);
	for await (const file of glob.scan({ cwd: project_root, onlyFiles: true })) {
		if (file.startsWith("node_modules/") || file.includes("/node_modules/")) continue;
		if (file.startsWith(".git/")) continue;
		if (skip_names.has(file)) continue;
		json_files.push(file);
	}
	json_files.sort();

	const items = [
		{ value: "__manual__", label: "Type a path manually" },
		...json_files.map((f) => ({ value: f, label: f })),
	];
	const result = await select_from_list("Select JSON file", items);
	if (!result) return null;
	if (result === "__manual__") {
		const manual = await ask("Path to JSON file (relative to project root)");
		return manual.trim() || null;
	}
	return result;
}

export async function run_json_to_sql(): Promise<void> {
	header("JSON to SQL table");

	const project_root = process.cwd();
	const json_path = await pick_json_file(project_root);
	if (!json_path) {
		console.log(`  ${dim("(cancelled)")}`);
		return;
	}

	const file = Bun.file(join(project_root, json_path));
	if (!(await file.exists())) {
		console.log(`  ${color(`File not found: ${json_path}`, YELLOW)}`);
		return;
	}

	let rows: Record<string, unknown>[];
	try {
		rows = extract_rows(JSON.parse(await file.text()));
	} catch (err) {
		console.log(`  ${color(`Could not parse ${json_path}: ${err}`, YELLOW)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Found ${rows.length} row(s) in ${color(json_path, GREEN)}`);

	let schema: InferredSchema;
	try {
		schema = infer_columns(rows);
	} catch (err) {
		console.log(`  ${color(`${err}`, YELLOW)}`);
		return;
	}

	const default_table = slugify_filename(json_path);
	let table = "";
	while (true) {
		const input = await ask("Table name (snake_case, plural)", default_table);
		try {
			table = validate_name(input, "Table name");
			break;
		} catch (err) {
			console.log(`  ${color(`${err}`, YELLOW)}`);
		}
	}

	console.log(`\n  ${dim("Inferred columns:")}`);
	if (schema.pk_from_data) console.log(`    ${color("id", GREEN)} (from JSON, PRIMARY KEY)`);
	for (const col of schema.columns) {
		const nullability = col.nullable ? "NULL" : "NOT NULL";
		console.log(`    ${color(col.name, GREEN)} ${dim(`${col.type} ${nullability}`)}`);
	}
	console.log(`  ${dim(`display column: ${schema.display_column}`)}`);
	if (schema.soft_fk_columns.length > 0) {
		console.log(`  ${color(`Note: ${schema.soft_fk_columns.join(", ")} look like foreign keys - review manually.`, YELLOW)}`);
	}
	console.log();

	const number = await next_sql_number(join(project_root, "sql", "mysql"));
	const default_slug = table;
	const slug_input = await ask(`File slug (files will be sql/{mysql,sqlite}/${number}-<slug>.sql)`, default_slug);
	const slug = validate_slug(slug_input);

	const mysql_path = join("sql", "mysql", `${number}-${slug}.sql`);
	const sqlite_path = join("sql", "sqlite", `${number}-${slug}.sql`);

	const proceed = await confirm(`Write ${mysql_path} and ${sqlite_path}?`, "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	const result = await convert_json_to_sql(json_path, table, { slug, project_root });

	console.log(`  ${color("✓", GREEN)} Wrote ${color(result.mysql_path, GREEN)}`);
	console.log(`  ${color("✓", GREEN)} Wrote ${color(result.sqlite_path, GREEN)}`);
	console.log(`  ${dim(`${result.row_count} row(s) seeded. Review the SQL, then run it via "Run SQL file" in this menu.`)}`);
	console.log(`  ${dim(`After applying: bun generator/resource.ts ${table}`)}`);

	await show_cli_tip(
		`bun reeman json-to-sql ${json_path} --table ${table} --slug ${slug}`,
		`Converted JSON to SQL: ${relative(project_root, join(project_root, mysql_path))}`
	);
}
