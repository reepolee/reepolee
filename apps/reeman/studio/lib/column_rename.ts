/**
 * Studio - propagate a column rename into the statements that reference it.
 *
 * Only `CREATE TABLE` is parsed into a typed model; INSERTs, triggers, and indexes
 * ride along as raw text. Renaming a column therefore updates the table definition
 * and leaves every other statement pointing at a name that no longer exists, and
 * the studio has no UI for those statements - the file simply stops loading, with
 * no way to repair it from the editor.
 *
 * Renames are rewritten textually, restricted to statements owned by the table
 * (`parent_table`) plus views that read from it. Identifiers are matched on word
 * boundaries and optional `alias.` / quoting, and string literals are skipped so
 * data is never rewritten.
 */

import type { StudioFile, StudioStatement, StudioTable } from "./types";

export interface ColumnRename {
	table: string;
	from: string;
	to: string;
}

/** Compare edited columns against their source rows to recover renames. */
export function detect_column_renames(source: StudioTable, edited: StudioTable, source_indexes: (number | null)[]): ColumnRename[] {
	const renames: ColumnRename[] = [];

	for (let index = 0; index < edited.columns.length; index++) {
		const source_index = source_indexes[index];
		if (source_index === null || source_index === undefined) continue;
		const original = source.columns[source_index];
		if (!original) continue;
		const new_name = edited.columns[index]!.name;
		if (original.name === new_name) continue;
		renames.push({ table: source.name, from: original.name, to: new_name });
	}

	return renames;
}

/**
 * Apply renames to every statement that references the table, excluding the
 * `CREATE TABLE` itself (already renamed in the typed model). Returns the names
 * of the statements that changed.
 */
export function apply_column_renames(model: StudioFile, renames: ColumnRename[]): string[] {
	if (renames.length === 0) return [];
	const touched: string[] = [];

	for (const statement of model.statements) {
		if (statement.kind === "create_table") continue;
		if (!statement.text) continue;

		const applicable = renames.filter((rename) => statement_references_table(statement, rename.table));
		if (applicable.length === 0) continue;

		let text = statement.text;
		for (const rename of applicable) text = rename_identifier(text, rename.from, rename.to);
		if (text === statement.text) continue;

		statement.text = text;
		const label = statement.object_name || statement.parent_table || statement.kind;
		if (!touched.includes(label)) touched.push(label);
	}

	return touched;
}

/** Whether a raw statement belongs to, or reads from, the renamed table. */
function statement_references_table(statement: StudioStatement, table_name: string): boolean {
	if (statement.parent_table === table_name) return true;
	// A view has no parent_table - match the table name inside its body instead.
	if (statement.kind !== "create_view") return false;
	const table_pattern = new RegExp(`\\b${escape_regex(table_name)}\\b`, "i");
	return table_pattern.test(statement.text);
}

/**
 * Replace a bare column identifier, preserving `alias.` prefixes and skipping
 * string literals and comments so only identifiers are rewritten.
 */
function rename_identifier(text: string, from: string, to: string): string {
	const pattern = new RegExp(`(^|[^\\w.'"\`])((?:[\\w]+\\.)?)(["\`]?)${escape_regex(from)}\\3(?![\\w])`, "g");
	let result = "";
	let index = 0;

	while (index < text.length) {
		const char = text[index]!;

		if (char === "'") {
			const end = skip_single_quoted(text, index);
			result += text.slice(index, end);
			index = end;
			continue;
		}
		if (char === "-" && text[index + 1] === "-") {
			const newline = text.indexOf("\n", index);
			const end = newline === -1 ? text.length : newline;
			result += text.slice(index, end);
			index = end;
			continue;
		}

		// Rewrite the next run of ordinary SQL up to the following literal/comment.
		const next_literal = next_boundary(text, index + 1);
		const chunk = text.slice(index, next_literal);
		result += chunk.replace(pattern, (_match, prefix: string, qualifier: string, quote: string) => `${prefix}${qualifier}${quote}${to}${quote}`);
		index = next_literal;
	}

	return result;
}

/** Index of the next string literal or line comment at or after `from_index`. */
function next_boundary(text: string, from_index: number): number {
	for (let index = from_index; index < text.length; index++) {
		if (text[index] === "'") return index;
		if (text[index] === "-" && text[index + 1] === "-") return index;
	}
	return text.length;
}

/** Index just past a single-quoted literal, honouring '' escaping. */
function skip_single_quoted(text: string, index: number): number {
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

function escape_regex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
