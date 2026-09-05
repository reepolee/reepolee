/**
 * Studio DDL parser - parses reepolee house-style .sql files into a StudioFile.
 *
 * Not a general SQL parser: it understands the exact statement shapes used in
 * sql/ and marketplace/ demo files. Anything unrecognized is preserved verbatim
 * as a "raw" statement, so parsing is always lossless.
 *
 * Statement splitting is string-aware ('' escapes), comment-aware (-- to EOL),
 * and trigger-aware (CREATE TRIGGER bodies contain top-level ";" until END).
 */

import { parse_column, parse_table_foreign_key, parse_table_unique_key } from "./column_parser";
import { read_paren_group } from "./sql_tokens";
import type { Dialect, StudioColumn, StudioFile, StudioStatement, TableForeignKey, TableUniqueKey } from "./types";

export { parse_column } from "./column_parser";

interface RawPart {
	gap: string;
	text: string;
}

/** Split file text into statements, each with the exact gap text before it. */
export function split_statements(source: string): { parts: RawPart[]; trailing: string; } {
	const parts: RawPart[] = [];
	let gap = "";
	let current = "";
	let i = 0;
	let in_string = false;
	let in_comment = false;
	let in_mid_comment = false;
	let paren_depth = 0;

	while (i < source.length) {
		const ch = source[i]!;
		const next = source[i + 1] ?? "";

		if (in_comment) {
			gap += ch;
			if (ch === "\n") in_comment = false;
			i++;
			continue;
		}

		if (in_mid_comment) {
			current += ch;
			if (ch === "\n") in_mid_comment = false;
			i++;
			continue;
		}

		if (in_string) {
			current += ch;
			if (ch === "'") {
				if (next === "'") {
					current += next;
					i += 2;
					continue;
				}
				in_string = false;
			}
			i++;
			continue;
		}

		// Comment starts in the gap region (between statements) or mid-statement (e.g.
		// a trailing "-- note" after a column inside a CREATE TABLE body).
		if (ch === "-" && next === "-") {
			if (current.trim() === "") {
				in_comment = true;
				gap += ch;
			} else {
				in_mid_comment = true;
				current += ch;
			}
			i++;
			continue;
		}

		if (ch === "'") in_string = true;
		if (ch === "(") paren_depth++;
		if (ch === ")") paren_depth = Math.max(0, paren_depth - 1);

		if (ch === ";" && paren_depth === 0) {
			current += ch;
			parts.push({ gap, text: current });
			gap = "";
			current = "";
			i++;
			continue;
		}

		if (current.trim() === "" && /\s/.test(ch)) {
			gap += ch;
		} else {
			current += ch;
		}
		i++;
	}

	return { parts, trailing: gap + current };
}

/**
 * Merge statement fragments of CREATE TRIGGER bodies: a trigger contains
 * top-level ";" inside BEGIN ... END, so the splitter cuts it into pieces.
 * Rejoin fragments from "CREATE TRIGGER" up to the fragment ending in "END;".
 */
function merge_trigger_parts(parts: RawPart[]): RawPart[] {
	const merged: RawPart[] = [];
	let i = 0;

	while (i < parts.length) {
		const part = parts[i]!;
		if (/^\s*CREATE\s+TRIGGER/i.test(part.text) && !/END\s*;\s*$/i.test(part.text)) {
			let text = part.text;
			i++;
			while (i < parts.length) {
				text += parts[i]!.gap + parts[i]!.text;
				const done = /END\s*;\s*$/i.test(parts[i]!.text);
				i++;
				if (done) break;
			}
			merged.push({ gap: part.gap, text });
			continue;
		}
		merged.push(part);
		i++;
	}

	return merged;
}

/** Split a CREATE TABLE body on top-level commas (paren-, string-, and comment-aware). */
export function split_top_level_commas(body: string): string[] {
	const items: string[] = [];
	let current = "";
	let depth = 0;
	let in_string = false;
	let in_comment = false;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		const next = body[i + 1] ?? "";

		if (in_comment) {
			current += ch;
			if (ch === "\n") in_comment = false;
			continue;
		}

		if (in_string) {
			current += ch;
			if (ch === "'") {
				if (next === "'") {
					current += next;
					i++;
				} else {
					in_string = false;
				}
			}
			continue;
		}

		if (ch === "-" && next === "-") {
			in_comment = true;
			current += ch;
			continue;
		}

		if (ch === "'") in_string = true;
		else if (ch === "(") depth++;
		else if (ch === ")") depth--;

		if (ch === "," && depth === 0) {
			items.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") items.push(current);
	return items;
}

/**
 * Identifier token as it may appear in repo SQL: bare snake_case, or
 * backtick / double-quote / bracket quoted (e.g. `` `order` ``, "my table", [x]).
 */
const IDENT_TOKEN = "(?:[A-Za-z0-9_]+|`[^`]*`|\"[^\"]*\"|\\[[^\\]]*\\])";

/** An identifier, optionally schema-qualified (e.g. `main.users`, `` `main`.`users` ``). */
const QUALIFIED_NAME = "(?:" + IDENT_TOKEN + "(?:\\." + IDENT_TOKEN + ")?)";

/** Legal clause between CREATE and the identifier for tables: SQLite TEMP/TEMPORARY, MySQL+SQLite IF NOT EXISTS. */
const TABLE_CLAUSE = "(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?";

/** Unquote and strip a schema qualifier from a captured identifier, e.g. "`main`.`users`" -> "users". */
function bare_identifier(raw: string): string {
	const token = raw.split(".").pop()!;
	if (token.length >= 2 && (token.startsWith("`") || token.startsWith("\"") || token.startsWith("["))) {
		return token.slice(1, -1);
	}
	return token;
}

/** Classify a statement and fill in object_name / parent_table / parsed table. */
export function classify_statement(part: RawPart): StudioStatement {
	const text = part.text.trim();
	const base: StudioStatement = { gap: part.gap, kind: "raw", object_name: "", text: part.text };

	let match = new RegExp("^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(" + QUALIFIED_NAME + ")", "i").exec(text);
	if (match) return { ...base, kind: "drop_table", object_name: bare_identifier(match[1]!) };

	match = new RegExp("^DROP\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?(" + QUALIFIED_NAME + ")", "i").exec(text);
	if (match) return { ...base, kind: "drop_view", object_name: bare_identifier(match[1]!) };

	// CREATE TABLE ... AS SELECT has no parenthesized column list, so it cannot be
	// edited in the table editor. Classify it raw: opening never breaks and the
	// statement is preserved verbatim on save.
	match = new RegExp("^CREATE\\s+" + TABLE_CLAUSE + "(" + QUALIFIED_NAME + ")\\s+AS\\s+SELECT", "i").exec(text);
	if (match) return { ...base, kind: "raw", object_name: bare_identifier(match[1]!) };

	const table_match = new RegExp("^CREATE\\s+(" + TABLE_CLAUSE + ")(" + QUALIFIED_NAME + ")\\s*\\(", "i").exec(text);
	if (table_match) {
		const clause_raw = table_match[1]!;
		const name_raw = table_match[2]!;
		const open = text.indexOf("(");
		const [body, end] = read_paren_group(text, open);
		const suffix = /^(\s*[^;]*)?;\s*$/s.exec(text.slice(end + 1));
		const table_suffix_raw = (suffix?.[1] ?? "").trim();

		const columns: StudioColumn[] = [];
		const table_foreign_keys: TableForeignKey[] = [];
		const table_unique_keys: TableUniqueKey[] = [];
		const extra_lines_raw: string[] = [];
		for (const item of split_top_level_commas(body)) {
			const fk = parse_table_foreign_key(item);
			if (fk) {
				table_foreign_keys.push(fk);
				continue;
			}
			const unique_key = parse_table_unique_key(item);
			if (unique_key) {
				table_unique_keys.push(unique_key);
				continue;
			}
			const column = parse_column(item);
			if (column) columns.push(column);
			else if (item.trim() !== "") extra_lines_raw.push(item.trim());
		}

		return {
			...base,
			kind: "create_table",
			object_name: bare_identifier(name_raw),
			table: {
				name: bare_identifier(name_raw),
				name_raw,
				create_prefix_raw: clause_raw,
				extra_lines_raw: extra_lines_raw.length > 0 ? extra_lines_raw : undefined,
				columns,
				table_foreign_keys,
				table_unique_keys,
				table_suffix_raw,
			},
		};
	}

	match = new RegExp("^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(" + QUALIFIED_NAME + ")\\s+ON\\s+(" + QUALIFIED_NAME + ")", "i").exec(text);
	if (match) return { ...base, kind: "index", object_name: bare_identifier(match[1]!), parent_table: bare_identifier(match[2]!) };

	const trigger_match = new RegExp("^CREATE\\s+TRIGGER\\s+(" + QUALIFIED_NAME + ")", "i").exec(text);
	if (trigger_match) {
		const on = new RegExp("\\bON\\s+(" + QUALIFIED_NAME + ")\\s+FOR\\s+EACH\\s+ROW", "i").exec(text);
		return { ...base, kind: "trigger", object_name: bare_identifier(trigger_match[1]!), parent_table: on ? bare_identifier(on[1]!) : "" };
	}

	match = new RegExp("^INSERT(?:\\s+IGNORE)?\\s+INTO\\s+(" + QUALIFIED_NAME + ")", "i").exec(text);
	if (match) return { ...base, kind: "insert", object_name: "", parent_table: bare_identifier(match[1]!) };

	match = new RegExp("^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(" + QUALIFIED_NAME + ")", "i").exec(text);
	if (match) return { ...base, kind: "create_view", object_name: bare_identifier(match[1]!) };

	return base;
}

/** Parse a full .sql file into a StudioFile model. */
export function parse_ddl_file(source: string, path: string, dialect: Dialect): StudioFile {
	const { parts, trailing } = split_statements(source);
	const merged = merge_trigger_parts(parts);
	const statements = merged.map(classify_statement);
	return { path, dialect, statements, trailing };
}
