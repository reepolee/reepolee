import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse_ddl_file } from "./ddl_parser";
import { serialize_studio_file } from "./ddl_writer";
import { get_domain_types, make_default_table, resolve_column_domain } from "./domain_types";
import { list_demo_files, resolve_demo_path } from "../../database/lib/sql_files";
import { append_studio_metadata, apply_studio_metadata, extract_studio_metadata } from "./studio_metadata";
import type { Dialect, StudioFile, StudioStatement, StudioTable } from "./types";

export class StudioError extends Error {}

export function dialect_from_path(path: string): Dialect {
	return path.replaceAll("\\", "/").includes("/mysql/") ? "mysql" : "sqlite";
}

export function read_studio_file(path: string): StudioFile {
	const abs_path = resolve_demo_path(path);
	if (!abs_path) throw new StudioError(`Not an editable SQL file: ${path}`);

	const source = readFileSync(abs_path, "utf-8");
	const extracted = extract_studio_metadata(source);
	const model = parse_ddl_file(extracted.sql, path, dialect_from_path(path));
	apply_studio_metadata(model.statements, extracted.metadata);
	const domain_names = new Set(get_domain_types(model.dialect).map((domain) => domain.name));
	for (const statement of model.statements) {
		for (const column of statement.table?.columns ?? []) {
			if (!column.domain_type || !domain_names.has(column.domain_type)) {
				column.domain_type = resolve_column_domain(column.name, column.type_string, model.dialect);
			}
		}
	}
	return model;
}

export function write_studio_file(model: StudioFile): StudioFile {
	const abs_path = resolve_demo_path(model.path);
	if (!abs_path) throw new StudioError(`Not an editable SQL file: ${model.path}`);
	return write_studio_file_to(model, abs_path, model.path);
}

/**
 * Derive a sibling copy path next to `path` (e.g. "01-init.sql" -> "01-init-adapted.sql"),
 * numbering further copies if that name is already taken.
 */
export function derive_copy_path(path: string, suffix: string): string {
	const dir = path.replace(/[^/\\]*$/, "");
	const file = path.slice(dir.length);
	const ext_match = /\.sql$/i.exec(file);
	const stem = ext_match ? file.slice(0, ext_match.index) : file;
	const ext = ext_match ? file.slice(ext_match.index) : "";

	let candidate = `${dir}${stem}-${suffix}${ext}`;
	let n = 2;
	while (resolve_demo_path(candidate)) {
		candidate = `${dir}${stem}-${suffix}-${n}${ext}`;
		n++;
	}
	return candidate;
}

/** Write a model to a brand-new sibling path (e.g. an Adapt Schema copy), leaving the source file untouched. */
export function write_studio_file_copy(model: StudioFile, new_path: string): StudioFile {
	const abs_path = resolve_new_sibling_path(model.path, new_path);
	return write_studio_file_to({ ...model, path: new_path }, abs_path, new_path);
}

/** Resolve `new_path` to an absolute path, requiring it to sit next to an already-editable `source_path`. */
function resolve_new_sibling_path(source_path: string, new_path: string): string {
	const source_abs = resolve_demo_path(source_path);
	if (!source_abs) throw new StudioError(`Not an editable SQL file: ${source_path}`);
	if (!new_path.endsWith(".sql")) throw new StudioError(`Not a SQL file: ${new_path}`);

	const source_dir = source_abs.replace(/[^/\\]*$/, "");
	const new_abs = resolve(source_dir, new_path.replace(/^.*[/\\]/, ""));
	if (new_abs.replace(/[^/\\]*$/, "") !== source_dir) throw new StudioError(`Invalid copy path: ${new_path}`);
	return new_abs;
}

function write_studio_file_to(model: StudioFile, abs_path: string, model_path: string): StudioFile {
	const sql = serialize_studio_file(model);
	const output = append_studio_metadata(sql, model.statements);
	const temp_path = `${abs_path}.studio.tmp`;
	writeFileSync(temp_path, output, "utf-8");
	renameSync(temp_path, abs_path);

	const extracted = extract_studio_metadata(output);
	const fresh = parse_ddl_file(extracted.sql, model_path, model.dialect);
	apply_studio_metadata(fresh.statements, extracted.metadata);
	return fresh;
}

export function get_table_statement(model: StudioFile, name: string): StudioStatement {
	const statement = model.statements.find((item) => item.kind === "create_table" && item.object_name === name && item.table);
	if (!statement) throw new StudioError(`Table not found: ${name}`);
	return statement;
}

export function get_studio_tables(model: StudioFile): StudioTable[] {
	return model.statements.filter((item) => item.kind === "create_table" && item.table).map((item) => item.table!);
}

/** Return every table defined alongside the selected Studio SQL file. */
export function get_folder_studio_tables(path: string): StudioTable[] {
	const normalized_path = path.replaceAll("\\", "/");
	const folder = normalized_path.slice(0, normalized_path.lastIndexOf("/"));
	const dialect = dialect_from_path(normalized_path);
	const files = list_demo_files().filter((file) => {
		const file_path = file.path.replaceAll("\\", "/");
		return file.dialect === dialect && file_path.slice(0, file_path.lastIndexOf("/")) === folder;
	});
	const tables: StudioTable[] = [];
	for (const file of files) {
		const model = read_studio_file(file.path);
		tables.push(...get_studio_tables(model));
	}
	return tables;
}

export function add_new_table(model: StudioFile, name: string): void {
	assert_new_table_name(model, name);
	const table = make_default_table(name, model.dialect);
	model.statements.push(new_table_placeholder(table));
}

export function copy_table(model: StudioFile, source_name: string, new_name: string): void {
	assert_new_table_name(model, new_name);
	const source = get_table_statement(model, source_name).table!;
	const table = structuredClone(source);
	table.name = new_name;
	for (const column of table.columns) {
		column.name_pad = undefined;
		column.type_pad = undefined;
	}
	model.statements.push(new_table_placeholder(table));
}

export function delete_table(model: StudioFile, table_name: string): void {
	get_table_statement(model, table_name);
	const view_name = `v_${table_name}`;
	model.statements = model.statements.filter((statement) => {
		if (statement.parent_table === table_name) return false;
		if ((statement.kind === "create_table" || statement.kind === "drop_table") && statement.object_name === table_name) return false;
		if ((statement.kind === "create_view" || statement.kind === "drop_view") && statement.object_name === view_name) return false;
		return true;
	});
}

export function delete_view(model: StudioFile, view_name: string): void {
	const exists = model.statements.some((statement) => statement.kind === "create_view" && statement.object_name === view_name);
	if (!exists) throw new StudioError(`View not found: ${view_name}`);
	model.statements = model.statements.filter((statement) => {
		return !((statement.kind === "create_view" || statement.kind === "drop_view") && statement.object_name === view_name);
	});
}

export function generate_view(model: StudioFile, table_name: string): string {
	const table = get_table_statement(model, table_name).table!;
	const view_name = `v_${table_name}`;
	const view_text = render_view(model, table);

	model.statements = model.statements.filter((statement) => {
		return !((statement.kind === "create_view" || statement.kind === "drop_view") && statement.object_name === view_name);
	});

	let drop_insert_at = model.statements.findIndex((statement) => statement.kind === "drop_table");
	if (drop_insert_at === -1) drop_insert_at = 0;
	insert_statement(model, drop_insert_at, {
		gap: drop_insert_at === 0 ? "" : "\n",
		kind: "drop_view",
		object_name: view_name,
		text: `DROP VIEW IF EXISTS ${view_name};`,
	});

	let create_insert_at = model.statements.findIndex((statement) => statement.kind === "create_view");
	if (create_insert_at === -1) create_insert_at = model.statements.length;
	insert_statement(model, create_insert_at, {
		gap: create_insert_at === 0 ? "" : "\n\n",
		kind: "create_view",
		object_name: view_name,
		text: view_text,
	});
	return view_name;
}

function insert_statement(model: StudioFile, index: number, statement: StudioStatement): void {
	const following = model.statements[index];
	if (following?.gap === "") following.gap = "\n\n";
	model.statements.splice(index, 0, statement);
}

function assert_new_table_name(model: StudioFile, name: string): void {
	if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new StudioError("Table name must be snake_case.");
	if (model.statements.some((item) => item.kind === "create_table" && item.object_name === name)) {
		throw new StudioError(`Table already exists: ${name}`);
	}
}

function new_table_placeholder(table: StudioTable): StudioStatement {
	return { gap: "", kind: "create_table", object_name: table.name, text: "", table, is_new: true };
}

export function render_view(model: StudioFile, table: StudioTable): string {
	const selected = table.columns.map((column) => `t.${column.name}`);

	const lines = [`CREATE VIEW v_${table.name} AS`, "SELECT"];
	for (let index = 0; index < selected.length; index++) {
		const comma = index === selected.length - 1 ? "" : ",";
		lines.push(`    ${selected[index]}${comma}`);
	}
	lines.push(`FROM ${table.name} t`);
	return `${lines.join("\n")};`;
}

const SYSTEM_COLUMN_NAMES = new Set(["id", "display", "option_display", "created_at", "updated_at"]);

export function is_system_column(column_name: string): boolean {
	return SYSTEM_COLUMN_NAMES.has(column_name);
}

export function detect_soft_reference(column_name: string, tables: StudioTable[]): { table: string; column: string; } | null {
	if (column_name === "id" || !column_name.endsWith("_id")) return null;
	const stem = column_name.slice(0, -3);
	const target = tables.find((table) => table.name === stem || table.name === `${stem}s` || table.name.replace(/ies$/, "y").replace(/s$/, "") === stem);
	if (!target?.columns.some((column) => column.name === "id")) return null;
	return { table: target.name, column: "id" };
}
