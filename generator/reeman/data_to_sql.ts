#!/usr/bin/env bun
/**
 * Data to SQL table - convert JSON, XLS, or XLSX data into new tables,
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
 * - run_data_to_sql()     - interactive reeman flow (path input + prompts)
 *
 * The generated SQL is a starting point, not a final schema - review it
 * before applying (foreign keys, uniqueness, view joins are not inferred).
 */

import { isAbsolute, join, relative } from "node:path";

import * as XLSX from "$vendor/xlsx.full.min.js";
import { DOMAIN_TYPES as MYSQL_DOMAIN_TYPES } from "$config/domain_types/mysql";
import { DOMAIN_TYPES as SQLITE_DOMAIN_TYPES } from "$config/domain_types/sqlite";
import { BOOLEAN_PREFIXES, FILE_SUFFIXES, IMAGE_SUFFIXES } from "$config/db_structure";
import { ask, color, confirm, dim, GREEN, header, multi_select, show_cli_tip, show_cli_tips, YELLOW } from "./ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ColumnType = "integer" | "float" | "boolean" | "string" | "text" | "json";
export type DomainDialect = "mysql" | "sqlite";

export interface InferredColumn {
	name: string;
	type: ColumnType;
	nullable: boolean;
	max_length: number; // only meaningful for "string"
	domain_type?: string | null;
}

export interface WorkbookSheet {
	name: string;
	rows: Record<string, unknown>[];
}

export interface SpreadsheetSheetSummary {
	name: string;
	row_count: number;
	columns: string[];
}

const DOMAIN_NAME_RULES = [
	{ suffix: "_id", domain: "foreign_key" },
	...IMAGE_SUFFIXES.map((suffix) => ({ suffix: suffix.toLowerCase(), domain: "image_path" })),
	...FILE_SUFFIXES.map((suffix) => ({ suffix: suffix.toLowerCase(), domain: "file_path" })),
	{ suffix: "_at", domain: "timestamp" },
	{ suffix: "_on", domain: "date" },
	{ suffix: "_days", domain: "days" },
	{ suffix: "_months", domain: "months" },
	{ suffix: "_years", domain: "years" },
	{ suffix: "_hours", domain: "hours" },
	{ suffix: "_minutes", domain: "minutes" },
] as const;

function domain_type_for_column(name: string, type: ColumnType, dialect: DomainDialect, is_data_pk = false): string | null {
	const domain_types = dialect === "mysql" ? MYSQL_DOMAIN_TYPES : SQLITE_DOMAIN_TYPES;
	const lower_name = name.toLowerCase();
	const conventional: Record<string, string> = {
		name: dialect === "mysql" ? "full_name" : "text",
		created_at: "timestamp",
		updated_at: "timestamp",
	};
	if (lower_name === "id" && is_data_pk) return "pk_id";
	if (conventional[lower_name]) return conventional[lower_name];
	if (lower_name in domain_types) return lower_name;
	for (const rule of DOMAIN_NAME_RULES) {
		if (lower_name.endsWith(rule.suffix) && rule.domain in domain_types && (rule.domain !== "foreign_key" || type === "integer")) return rule.domain;
	}
	for (const prefix of BOOLEAN_PREFIXES) {
		if (lower_name.startsWith(prefix.toLowerCase()) && "boolean" in domain_types) return "boolean";
	}
	const type_domains: Record<ColumnType, string[]> = {
		integer: ["integer", "bigint", "foreign_key"],
		float: ["numeric", "decimal", "float", "double", "real"],
		boolean: ["boolean"],
		string: ["varchar", "text", "short_text", "full_name"],
		text: ["longtext", "text", "long_description"],
		json: ["json", "json_data"],
	};
	return type_domains[type].find((candidate) => candidate in domain_types) ?? null;
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

function has_numeric_data_primary_key(rows: Record<string, unknown>[]): boolean {
	const first_row = rows[0];
	const id_key = first_row ? Object.keys(first_row).find((key) => key.toLowerCase() === "id") : undefined;
	if (!id_key || rows.some((row) => !Object.prototype.hasOwnProperty.call(row, id_key))) return false;
	const id_values = rows.map((row) => row[id_key]);
	const numeric_values = id_values.map((value) => {
		const numeric_value = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
		return Number.isSafeInteger(numeric_value) ? numeric_value : null;
	});
	return numeric_values.every((value) => value !== null) && new Set(numeric_values).size === rows.length;
}

/** Rename an incoming id-like column when the converter must add its own primary key. */
export function normalize_import_rows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
	const first_row = rows[0];
	const id_key = first_row ? Object.keys(first_row).find((key) => key.toLowerCase() === "id") : undefined;
	if (id_key && has_numeric_data_primary_key(rows)) {
		return rows.map((row) => {
			const normalized_row: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(row)) {
				const normalized_value = key === id_key ? Number(value) : value;
				normalized_row[key === id_key ? "id" : key] = normalized_value;
			}
			return normalized_row;
		});
	}

	return rows.map((row) => {
		const id_key = Object.keys(row).find((key) => key.toLowerCase() === "id");
		if (!id_key) return row;
		if (Object.prototype.hasOwnProperty.call(row, "original_id")) {
			throw new Error("Cannot rename incoming id to original_id because original_id already exists.");
		}

		const normalized_row: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) normalized_row[key === id_key ? "original_id" : key] = value;
		return normalized_row;
	});
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

export function infer_columns(rows: Record<string, unknown>[], dialect: DomainDialect = "mysql"): InferredSchema {
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
	const original_id_index = data_keys.indexOf("original_id");
	if (original_id_index > 0) {
		data_keys.splice(original_id_index, 1);
		data_keys.unshift("original_id");
	}

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

		return { name: key, type, nullable, max_length, domain_type: domain_type_for_column(key, type, dialect, pk_from_data && key === "id") };
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

function canonical_sql_type(col: InferredColumn, dialect: DomainDialect): string {
	const domain_types = dialect === "mysql" ? MYSQL_DOMAIN_TYPES : SQLITE_DOMAIN_TYPES;
	const domain_type = col.domain_type ? domain_types[col.domain_type as keyof typeof domain_types] : undefined;
	if (domain_type) return domain_type;
	if (dialect === "mysql") {
		switch (col.type) {
			case "integer": return "INT";
			case "float": return "DECIMAL(18,2)";
			case "boolean": return "TINYINT(1)";
			case "string": return `VARCHAR(${bucket_length(col.max_length)})`;
			case "text": return "TEXT";
			case "json": return "JSON";
		}
	}
	return col.type === "integer" ? "INTEGER" : col.type === "float" ? "REAL" : col.type === "boolean" ? "INTEGER" : col.type === "json" ? "JSON" : "TEXT";
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

function synthetic_primary_key_name(columns: InferredColumn[], pk_from_data: boolean): string {
	if (pk_from_data) return "id";
	return columns.some((column) => column.name.toLowerCase() === "id") ? "row_id" : "id";
}

function column_name_width(columns: InferredColumn[], primary_key_name: string): number {
	const all_names = [primary_key_name, ...columns.map((c) => c.name), "display", "created_at", "updated_at", "archived_at", "archived_by_user_id"];
	return Math.max(...all_names.map((n) => n.length)) + 2;
}

export function build_mysql_sql(opts: BuildSqlOptions): string {
	const { table, columns, pk_from_data, display_column, soft_fk_columns, rows } = opts;
	const primary_key_name = synthetic_primary_key_name(columns, pk_from_data);
	const name_w = column_name_width(columns, primary_key_name);

	const lines: string[] = [`DROP TABLE IF EXISTS ${table};`, "", `CREATE TABLE ${table} (`];

	const col_lines: string[] = [];
	col_lines.push(`    ${primary_key_name.padEnd(name_w)}INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'ICU'`);
	for (const col of columns) {
		const sql_type = canonical_sql_type(col, "mysql");
		const nullability = col.nullable ? "DEFAULT NULL" : `NOT NULL DEFAULT ${default_literal(col)}`;
		col_lines.push(`    ${col.name.padEnd(name_w)}${sql_type} ${nullability} COMMENT 'ICU'`);
	}
	const display_ref = display_column === "id" ? "id" : display_column;
	col_lines.push(`    ${"display".padEnd(name_w)}VARCHAR(255) GENERATED ALWAYS AS (${display_ref}) VIRTUAL`);
	col_lines.push(`    ${"created_at".padEnd(name_w)}TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP`);
	col_lines.push(`    ${"updated_at".padEnd(name_w)}TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
	col_lines.push(`    ${"archived_at".padEnd(name_w)}TIMESTAMP    NULL DEFAULT NULL`);
	col_lines.push(`    ${"archived_by_user_id".padEnd(name_w)}INT UNSIGNED NULL DEFAULT NULL`);

	lines.push(col_lines.join(",\n"));
	lines.push(`) COMMENT '';`);
	lines.push("");

	for (const fk of soft_fk_columns) { lines.push(`CREATE INDEX ${table}_${fk} ON ${table}(${fk});`); }
	lines.push(`CREATE INDEX ${table}_archived_at ON ${table}(archived_at);`);
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
	const primary_key_name = synthetic_primary_key_name(columns, pk_from_data);
	const name_w = column_name_width(columns, primary_key_name);

	const lines: string[] = [`DROP TABLE IF EXISTS ${table};`, "", `CREATE TABLE ${table} (`];

	const col_lines: string[] = [];
	col_lines.push(`    ${primary_key_name.padEnd(name_w)}INTEGER   PRIMARY KEY`);
	for (const col of columns) {
		const sql_type = canonical_sql_type(col, "sqlite");
		const nullability = col.nullable ? "" : `NOT NULL DEFAULT ${default_literal(col)}`;
		col_lines.push(`    ${col.name.padEnd(name_w)}${sql_type} ${nullability}`.trimEnd());
	}
	const display_ref = display_column === "id" ? "id" : display_column;
	col_lines.push(`    ${"display".padEnd(name_w)}TEXT      GENERATED ALWAYS AS (${display_ref}) VIRTUAL`);
	col_lines.push(`    ${"created_at".padEnd(name_w)}TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`);
	col_lines.push(`    ${"updated_at".padEnd(name_w)}TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
	col_lines.push(`    ${"archived_at".padEnd(name_w)}TIMESTAMP DEFAULT NULL`);
	col_lines.push(`    ${"archived_by_user_id".padEnd(name_w)}INTEGER DEFAULT NULL`);

	lines.push(col_lines.join(",\n"));
	lines.push(");");
	lines.push("");

	for (const fk of soft_fk_columns) { lines.push(`CREATE INDEX ${table}_${fk} ON ${table}(${fk});`); }
	lines.push(`CREATE INDEX ${table}_archived_at ON ${table}(archived_at);`);

	lines.push(
		`CREATE TRIGGER ${table}_updated_at_trigger AFTER UPDATE ON ${table} FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN UPDATE ${table} SET updated_at = CURRENT_TIMESTAMP WHERE ${primary_key_name} = NEW.${primary_key_name}; END;`
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
	const base = path.split("/").pop()!.replace(/\.(?:json|xls|xlsx)$/i, "");
	const snake = base
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.toLowerCase()
		.replace(/^_+|_+$/g, "");
	return snake || "data";
}

export function suggest_table_name(path_or_sheet: string): string {
	const suggested_name = slugify_filename(path_or_sheet);
	return /^[a-z]/.test(suggested_name) ? suggested_name : `data_${suggested_name}`;
}

export function sheet_table_name(base_table: string, sheet_name: string, sheet_index: number): string {
	const sheet_slug = slugify_filename(`${sheet_name}.xlsx`);
	const suffix = sheet_slug || `sheet_${sheet_index + 1}`;
	return validate_name(`${base_table}_${suffix}`, "Table name");
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

export function workbook_to_sheets(data: ArrayBuffer | Uint8Array): WorkbookSheet[] {
	const workbook = XLSX.read(data, { type: "array", cellDates: true, cellNF: false, cellText: false });
	return workbook.SheetNames.map((name: string) => {
		const worksheet = workbook.Sheets[name];
		const rows = XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true }) as Record<string, unknown>[];
		return { name, rows };
	});
}

export async function read_spreadsheet_sheets(file_path: string): Promise<SpreadsheetSheetSummary[]> {
	const file = Bun.file(file_path);
	if (!(await file.exists())) throw new Error(`File not found: ${file_path}`);
	const sheets = workbook_to_sheets(await file.bytes());
	return sheets.map((sheet) => ({
		name: sheet.name,
		row_count: sheet.rows.length,
		columns: sheet.rows[0] ? Object.keys(sheet.rows[0]) : [],
	}));
}

export async function read_spreadsheet_rows(file_path: string): Promise<{ rows: Record<string, unknown>[]; sheets: WorkbookSheet[] }> {
	const bytes = await Bun.file(file_path).bytes();
	const sheets = workbook_to_sheets(bytes);
	const first_sheet = sheets.find((sheet) => sheet.rows.length > 0);
	if (!first_sheet) throw new Error("The spreadsheet contains no rows.");
	return { rows: first_sheet.rows, sheets };
}

// ---------------------------------------------------------------------------
// Core conversion - read JSON, XLS, or XLSX, infer schema, write the paired SQL files.
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
	options: { slug?: string; project_root?: string; sheet?: string } = {}
): Promise<ConvertResult> {
	const validated_table = validate_name(table, "Table name");
	const project_root = options.project_root ?? process.cwd();
	const slug = validate_slug(options.slug ?? validated_table);

	const input_path = isAbsolute(json_path) ? json_path : join(project_root, json_path);
	const file = Bun.file(input_path);
	if (!(await file.exists())) throw new Error(`File not found: ${json_path}`);

	const parsed = JSON.parse(await file.text());
	const rows = normalize_import_rows(extract_rows(parsed));
	const schema = infer_columns(rows, "mysql");

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

export async function convert_spreadsheet_to_sql(
	spreadsheet_path: string,
	table: string,
	options: { slug?: string; project_root?: string; sheet?: string } = {}
): Promise<ConvertResult & { sheets: string[] }> {
	const validated_table = validate_name(table, "Table name");
	const project_root = options.project_root ?? process.cwd();
	const slug = validate_slug(options.slug ?? validated_table);
	const input_path = isAbsolute(spreadsheet_path) ? spreadsheet_path : join(project_root, spreadsheet_path);
	const file = Bun.file(input_path);
	if (!(await file.exists())) throw new Error(`File not found: ${spreadsheet_path}`);
	const workbook = await read_spreadsheet_rows(input_path);
	const selected_sheet = options.sheet === undefined
		? workbook.sheets.find((sheet) => sheet.rows.length > 0)
		: workbook.sheets.find((sheet) => sheet.name === options.sheet);
	if (!selected_sheet) throw new Error(options.sheet === undefined ? "The spreadsheet contains no rows." : `Sheet not found: ${options.sheet}`);
	if (selected_sheet.rows.length === 0) throw new Error(`Sheet contains no rows: ${selected_sheet.name}`);
	const rows = normalize_import_rows(selected_sheet.rows);
	const schema = infer_columns(rows, "mysql");
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
	return { mysql_path, sqlite_path, schema, row_count: rows.length, sheets: [selected_sheet.name] };
}

export interface ConvertSpreadsheetAllResult {
	tables: Array<ConvertResult & { sheet: string; table: string }>;
	sheets: string[];
	skipped_sheets: string[];
}

export interface SpreadsheetTableSelection {
	sheet: string;
	table: string;
}

export async function convert_spreadsheet_selections_to_sql(
	spreadsheet_path: string,
	selections: SpreadsheetTableSelection[],
	options: { project_root?: string } = {}
): Promise<ConvertSpreadsheetAllResult> {
	if (selections.length === 0) throw new Error("Select at least one spreadsheet sheet.");
	const project_root = options.project_root ?? process.cwd();
	const input_path = isAbsolute(spreadsheet_path) ? spreadsheet_path : join(project_root, spreadsheet_path);
	const file = Bun.file(input_path);
	if (!(await file.exists())) throw new Error(`File not found: ${spreadsheet_path}`);
	const workbook = await read_spreadsheet_rows(input_path);
	const sheet_by_name = new Map(workbook.sheets.map((sheet) => [sheet.name, sheet]));
	const results: Array<ConvertResult & { sheet: string; table: string }> = [];
	const skipped_sheets: string[] = [];

	for (const selection of selections) {
		const sheet = sheet_by_name.get(selection.sheet);
		if (!sheet) throw new Error(`Sheet not found: ${selection.sheet}`);
		if (sheet.rows.length === 0) {
			skipped_sheets.push(sheet.name);
			continue;
		}
		const table = validate_name(selection.table, `Table name for ${sheet.name}`);
		const rows = normalize_import_rows(sheet.rows);
		const schema = infer_columns(rows, "mysql");
		const number = await next_sql_number(join(project_root, "sql", "mysql"));
		const filename = `${number}-${table.replaceAll("_", "-")}.sql`;
		const mysql_path = join("sql", "mysql", filename);
		const sqlite_path = join("sql", "sqlite", filename);
		const build_opts: BuildSqlOptions = {
			table,
			columns: schema.columns,
			pk_from_data: schema.pk_from_data,
			display_column: schema.display_column,
			soft_fk_columns: schema.soft_fk_columns,
			rows,
		};
		await Bun.write(join(project_root, mysql_path), build_mysql_sql(build_opts));
		await Bun.write(join(project_root, sqlite_path), build_sqlite_sql(build_opts));
		results.push({ mysql_path, sqlite_path, schema, row_count: rows.length, sheet: sheet.name, table });
	}

	return { tables: results, sheets: workbook.sheets.map((sheet) => sheet.name), skipped_sheets };
}

export async function convert_spreadsheet_to_sql_all(
	spreadsheet_path: string,
	table: string,
	options: { slug?: string; project_root?: string; sheet?: string } = {}
): Promise<ConvertSpreadsheetAllResult> {
	const validated_table = validate_name(table, "Table name");
	const project_root = options.project_root ?? process.cwd();
	const slug = validate_slug(options.slug ?? validated_table);
	const input_path = isAbsolute(spreadsheet_path) ? spreadsheet_path : join(project_root, spreadsheet_path);
	const file = Bun.file(input_path);
	if (!(await file.exists())) throw new Error(`File not found: ${spreadsheet_path}`);
	const workbook = await read_spreadsheet_rows(input_path);
	const selected_sheets = options.sheet === undefined
		? workbook.sheets
		: workbook.sheets.filter((sheet) => sheet.name === options.sheet);
	if (options.sheet !== undefined && selected_sheets.length === 0) {
		throw new Error(`Sheet not found: ${options.sheet}`);
	}
	const results: Array<ConvertResult & { sheet: string; table: string }> = [];
	const skipped_sheets: string[] = [];

	for (const [sheet_index, sheet] of selected_sheets.entries()) {
		if (sheet.rows.length === 0) {
			skipped_sheets.push(sheet.name);
			continue;
		}
		const sheet_table = sheet_table_name(validated_table, sheet.name, sheet_index);
		const sheet_slug = slugify_filename(sheet.name) || `sheet-${sheet_index + 1}`;
		const rows = normalize_import_rows(sheet.rows);
		const schema = infer_columns(rows, "mysql");
		const number = await next_sql_number(join(project_root, "sql", "mysql"));
		const filename = `${number}-${slug}-${sheet_slug.replaceAll("_", "-")}.sql`;
		const mysql_path = join("sql", "mysql", filename);
		const sqlite_path = join("sql", "sqlite", filename);
		const build_opts: BuildSqlOptions = {
			table: sheet_table,
			columns: schema.columns,
			pk_from_data: schema.pk_from_data,
			display_column: schema.display_column,
			soft_fk_columns: schema.soft_fk_columns,
			rows,
		};
		await Bun.write(join(project_root, mysql_path), build_mysql_sql(build_opts));
		await Bun.write(join(project_root, sqlite_path), build_sqlite_sql(build_opts));
		results.push({ mysql_path, sqlite_path, schema, row_count: rows.length, sheet: sheet.name, table: sheet_table });
	}

	return { tables: results, sheets: workbook.sheets.map((sheet) => sheet.name), skipped_sheets };
}

// ---------------------------------------------------------------------------
// Interactive reeman flow
// ---------------------------------------------------------------------------

export function normalize_import_path(input: string): string {
	const trimmed_input = input.trim();
	const has_matching_quotes = (trimmed_input.startsWith('"') && trimmed_input.endsWith('"'))
		|| (trimmed_input.startsWith("'") && trimmed_input.endsWith("'"));
	return has_matching_quotes ? trimmed_input.slice(1, -1).trim() : trimmed_input;
}

async function ask_import_file(): Promise<string | null> {
	const input = await ask("Path to JSON, XLS, or XLSX file (absolute or relative to project root)");
	return normalize_import_path(input) || null;
}

async function run_spreadsheet_to_sql(import_path: string, resolved_import_path: string, project_root: string): Promise<void> {
	let workbook: { rows: Record<string, unknown>[]; sheets: WorkbookSheet[] };
	try {
		workbook = await read_spreadsheet_rows(resolved_import_path);
	} catch (err) {
		console.log(`  ${color(`Could not parse ${import_path}: ${err}`, YELLOW)}`);
		return;
	}

	const non_empty_sheets = workbook.sheets.filter((sheet) => sheet.rows.length > 0);
	console.log(`  ${color("✓", GREEN)} Found ${non_empty_sheets.length} non-empty sheet(s) in ${color(import_path, GREEN)}`);
	const selected_sheets = await multi_select(
		"Select sheets to import (arrows + space + enter)",
		non_empty_sheets.map((sheet) => ({
			value: sheet,
			label: `${sheet.name} ${dim(`(${sheet.rows.length} rows, ${Object.keys(sheet.rows[0] ?? {}).length} columns)`)}`,
		})),
	);

	const selections: SpreadsheetTableSelection[] = [];
	for (const sheet of selected_sheets) {
		const default_table = suggest_table_name(sheet.name);
		let table = "";
		while (true) {
			const input = await ask(`Table name for sheet "${sheet.name}"`, default_table);
			try {
				table = validate_name(input, `Table name for ${sheet.name}`);
				break;
			} catch (err) {
				console.log(`  ${color(`${err}`, YELLOW)}`);
			}
		}
		selections.push({ sheet: sheet.name, table });
	}

	console.log(`\n  ${dim("Import plan:")}`);
	for (const selection of selections) console.log(`    ${color(selection.sheet, GREEN)} -> ${selection.table}`);
	const proceed = await confirm(`Write paired MySQL/SQLite SQL files for ${selections.length} sheet(s)?`, "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	const result = await convert_spreadsheet_selections_to_sql(import_path, selections, { project_root });
	for (const table of result.tables) {
		console.log(`  ${color("✓", GREEN)} Wrote ${color(table.mysql_path, GREEN)}`);
		console.log(`  ${color("✓", GREEN)} Wrote ${color(table.sqlite_path, GREEN)}`);
		console.log(`  ${dim(`${table.row_count} row(s) from "${table.sheet}" seeded into ${table.table}.`)}`);
		console.log(`  ${dim(`After applying: bun generator/resource.ts ${table.table}`)}`);
	}

	const replay_commands = selections.map((selection) => {
		return `bun reeman spreadsheet-to-sql "${import_path}" --sheet "${selection.sheet}" --table ${selection.table}`;
	});
	await show_cli_tips(replay_commands, `Converted ${selections.length} spreadsheet sheet(s) to SQL`);
}

export async function run_data_to_sql(): Promise<void> {
	header("Data to SQL table");

	const project_root = process.cwd();
	const import_path = await ask_import_file();
	if (!import_path) {
		console.log(`  ${dim("(cancelled)")}`);
		return;
	}

	const resolved_import_path = isAbsolute(import_path) ? import_path : join(project_root, import_path);
	const file = Bun.file(resolved_import_path);
	if (!(await file.exists())) {
		console.log(`  ${color(`File not found: ${import_path}`, YELLOW)}`);
		return;
	}

	const is_spreadsheet = /\.(?:xls|xlsx)$/i.test(import_path);
	if (is_spreadsheet) {
		await run_spreadsheet_to_sql(import_path, resolved_import_path, project_root);
		return;
	}
	let rows: Record<string, unknown>[];
	try {
		rows = extract_rows(JSON.parse(await file.text()));
	} catch (err) {
		console.log(`  ${color(`Could not parse ${import_path}: ${err}`, YELLOW)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Found ${rows.length} row(s) in ${color(import_path, GREEN)}`);

	let schema: InferredSchema;
	try {
		schema = infer_columns(rows);
	} catch (err) {
		console.log(`  ${color(`${err}`, YELLOW)}`);
		return;
	}

	const default_table = slugify_filename(import_path);
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

	const result = await convert_json_to_sql(import_path, table, { slug, project_root });

	console.log(`  ${color("✓", GREEN)} Wrote ${color(result.mysql_path, GREEN)}`);
	console.log(`  ${color("✓", GREEN)} Wrote ${color(result.sqlite_path, GREEN)}`);
	console.log(`  ${dim(`${result.row_count} row(s) seeded. Review the SQL, then run it via "Run SQL file" in this menu.`)}`);
	console.log(`  ${dim(`After applying: bun generator/resource.ts ${table}`)}`);

	await show_cli_tip(
		`bun reeman json-to-sql ${import_path} --table ${table} --slug ${slug}`,
		`Converted import to SQL: ${relative(project_root, join(project_root, mysql_path))}`
	);
}
