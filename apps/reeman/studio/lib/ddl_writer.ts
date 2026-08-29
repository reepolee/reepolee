/**
 * Studio DDL writer - regenerates CREATE TABLE statements from the typed model
 * in the exact reepolee house style (4-space indent, name/type columns padded
 * to widest + 1, modifiers in each column's original order), and serializes a
 * full StudioFile back to .sql text.
 *
 * Only statements marked dirty/is_new are regenerated; everything else is
 * emitted verbatim, so saving an untouched table produces a zero-byte diff.
 */

import type { Dialect, ModifierKey, StudioColumn, StudioFile, StudioStatement, StudioTable } from "./types";

/** Default modifier order for columns created in the editor. */
function default_modifier_order(dialect: Dialect): ModifierKey[] {
	return dialect === "mysql"
		? ["nullability", "auto_increment", "primary_key", "default", "unique", "generated", "on_update", "references", "comment"]
		: ["nullability", "primary_key", "auto_increment", "default", "unique", "generated", "references", "comment"];
}

function escape_sql_string(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** Render one modifier of a column, keyed by name. */
function render_modifier(column: StudioColumn, key: ModifierKey, dialect: Dialect): string {
	switch (key) {
		case "nullability":
			if (column.nullability === "not_null") return "NOT NULL";
			if (column.nullability === "null") return "NULL";
			return "";
		case "primary_key":
			return column.is_primary_key ? "PRIMARY KEY" : "";
		case "auto_increment":
			if (!column.is_auto_increment) return "";
			return dialect === "mysql" ? "AUTO_INCREMENT" : "AUTOINCREMENT";
		case "default":
			return column.default_value !== null ? `DEFAULT ${column.default_value}` : "";
		case "unique":
			return column.is_unique ? "UNIQUE" : "";
		case "generated": {
			if (!column.is_generated) return "";
			const kind = column.generated_kind ?? "VIRTUAL";
			const as_pad = column.generated_as_pad ?? " ";
			return `GENERATED ALWAYS AS${as_pad}(${column.generated_expr ?? ""}) ${kind}`;
		}
		case "on_update":
			return column.on_update_current_timestamp ? "ON UPDATE CURRENT_TIMESTAMP" : "";
		case "references": {
			if (!column.references) return "";
			const ref = column.references;
			let text = `REFERENCES ${ref.table}(${ref.column})`;
			if (ref.on_update) text += ` ON UPDATE ${ref.on_update}`;
			if (ref.on_delete) text += ` ON DELETE ${ref.on_delete}`;
			return text;
		}
		case "comment":
			return column.comment !== undefined ? `COMMENT ${escape_sql_string(column.comment)}` : "";
	}
}

/** Render a column's modifier text (everything after the type), preserving order. */
export function render_column_modifiers(column: StudioColumn, dialect: Dialect): string {
	const order = column.modifier_order.length > 0 ? column.modifier_order : default_modifier_order(dialect);
	const parts: string[] = [];

	for (const key of order) {
		const rendered = render_modifier(column, key, dialect);
		if (rendered) parts.push(rendered);
	}
	if (column.extra_raw) parts.push(column.extra_raw);

	return parts.join(" ");
}

/** Most frequent value in a list (used to pick the dominant column alignment width). */
function mode_width(widths: number[], fallback: number): number {
	if (widths.length === 0) return fallback;
	const counts = new Map<number, number>();
	for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
	let best = fallback;
	let best_count = 0;
	for (const [width, count] of counts) {
		if (count > best_count) {
			best = width;
			best_count = count;
		}
	}
	return best;
}

/** Regenerate a CREATE TABLE statement in aligned house style. */
export function render_create_table(table: StudioTable, dialect: Dialect): string {
	const lines: string[] = [];

	// Columns parsed from a file carry their original padding (hand-aligned files
	// are not always max+1, e.g. option_display). New columns get the dominant width.
	const fallback_name_width = Math.max(...table.columns.map((c) => c.name.length)) + 1;
	const fallback_type_width = Math.max(...table.columns.map((c) => c.type_string.length)) + 1;
	const name_width = mode_width(table.columns.filter((c) => c.name_pad).map((c) => c.name.length + c.name_pad!.length), fallback_name_width);
	const type_width = mode_width(table.columns.filter((c) => c.type_pad).map((c) => c.type_string.length + c.type_pad!.length), fallback_type_width);

	for (const column of table.columns) {
		const name_part = column.name_pad !== undefined
			? column.name + column.name_pad
			: column.name.padEnd(Math.max(name_width, column.name.length + 1));
		const type_part = column.type_pad !== undefined
			? column.type_string + column.type_pad
			: column.type_string.padEnd(Math.max(type_width, column.type_string.length + 1));
		const modifiers = render_column_modifiers(column, dialect);
		lines.push(`    ${name_part}${type_part}${modifiers}`.trimEnd());
	}

	for (const fk of table.table_foreign_keys) {
		const prefix = fk.constraint_name ? `CONSTRAINT ${fk.constraint_name} ` : "";
		let line = `    ${prefix}FOREIGN KEY(${fk.column}) REFERENCES ${fk.ref_table}(${fk.ref_column})`;
		if (fk.on_update) line += ` ON UPDATE ${fk.on_update}`;
		if (fk.on_delete) line += ` ON DELETE ${fk.on_delete}`;
		lines.push(line);
	}

	const body = lines.join(",\n");
	const suffix = table.table_suffix_raw ? ` ${table.table_suffix_raw}` : "";
	return `CREATE TABLE ${table.name} (\n${body}\n)${suffix};`;
}

/** Render a CREATE INDEX statement in house style. */
export function render_index(name: string, table: string, columns: string[], unique: boolean): string {
	const keyword = unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
	return `${keyword} ${name} ON ${table}(${columns.join(", ")});`;
}

/** The sqlite updated_at trigger, 05-frameworks style. */
export function render_updated_at_trigger(table_name: string): string {
	return `CREATE TRIGGER ${table_name}_updated_at_trigger AFTER UPDATE ON ${table_name} FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at BEGIN
    UPDATE ${table_name}
    SET
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.id;
END;`;
}

function make_statement(gap: string, kind: StudioStatement["kind"], object_name: string, text: string, extra: Partial<StudioStatement> = {}): StudioStatement {
	return { gap, kind, object_name, text, ...extra };
}

/**
 * Build the statement set (drop, create, index, trigger) for a newly added table.
 * The drop sits immediately before the create, matching the interleaved style of
 * the 05-frameworks.sql demo files.
 */
export function build_new_table_statements(table: StudioTable, dialect: Dialect): StudioStatement[] {
	const statements: StudioStatement[] = [
		make_statement("\n\n", "drop_table", table.name, `DROP TABLE IF EXISTS ${table.name};`),
		make_statement("\n\n", "create_table", table.name, render_create_table(table, dialect), { table, dirty: false }),
	];

	const name_column = table.columns.find((c) => c.name === "name");
	if (name_column) {
		statements.push(make_statement("\n\n", "index", `${table.name}_name`, render_index(`${table.name}_name`, table.name, ["name"], false), { parent_table: table.name }));
	}

	if (dialect === "sqlite" && table.columns.some((c) => c.name === "updated_at")) {
		statements.push(make_statement("\n\n", "trigger", `${table.name}_updated_at_trigger`, render_updated_at_trigger(table.name), { parent_table: table.name }));
	}

	return statements;
}

/** Insert statements for new tables before the first view (or at the end of the file). */
function splice_new_tables(statements: StudioStatement[], dialect: Dialect): StudioStatement[] {
	const result = [...statements];
	const new_tables = result.filter((s) => s.kind === "create_table" && s.is_new && s.table);

	for (const stmt of new_tables) {
		const generated = build_new_table_statements(stmt.table!, dialect);
		result.splice(result.indexOf(stmt), 1);

		let insert_at = result.findIndex((s) => s.kind === "create_view");
		if (insert_at === -1) insert_at = result.length;

		// The first generated statement takes over the gap of whatever followed
		// the insertion point; the displaced statement keeps its own gap after.
		if (insert_at < result.length) {
			generated[0]!.gap = result[insert_at]!.gap;
			result[insert_at]!.gap = "\n\n";
		}
		result.splice(insert_at, 0, ...generated);
	}

	return result;
}

/**
 * Serialize a StudioFile back to .sql text.
 * Dirty/new create_table statements are regenerated; all other text is verbatim.
 */
export function serialize_studio_file(file: StudioFile): string {
	const statements = splice_new_tables(file.statements, file.dialect);
	let out = "";

	for (const stmt of statements) {
		out += stmt.gap;
		if (stmt.kind === "create_table" && stmt.table && (stmt.dirty || stmt.is_new)) {
			out += render_create_table(stmt.table, file.dialect);
		} else {
			out += stmt.text;
		}
	}

	return out + file.trailing;
}
