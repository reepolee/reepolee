import { read_paren_group, read_quoted_token } from "./sql_tokens";
import type { ColumnReference, StudioColumn, TableForeignKey, TableUniqueKey } from "./types";

function parse_references(rest: string): { reference: ColumnReference; consumed: number; } | null {
	const match = /^REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)/i.exec(rest);
	if (!match) return null;

	const reference: ColumnReference = { table: match[1]!, column: match[2]! };
	let tail = rest.slice(match[0].length);
	const action = /^\s+ON\s+(UPDATE|DELETE)\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i;
	let action_match = action.exec(tail);
	while (action_match) {
		if (action_match[1]!.toUpperCase() === "UPDATE") reference.on_update = action_match[2]!.toUpperCase();
		else reference.on_delete = action_match[2]!.toUpperCase();
		tail = tail.slice(action_match[0].length);
		action_match = action.exec(tail);
	}
	return { reference, consumed: rest.length - tail.length };
}

/** Parse one column line of a CREATE TABLE body. */
export function parse_column(line: string): StudioColumn | null {
	const trimmed = strip_line_comments(line).trim();
	if (trimmed === "") return null;
	if (/^(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE\s*\(|CONSTRAINT|CHECK\s*\(|KEY\s)/i.test(trimmed)) return null;

	const head = /^(\w+)(\s+)([A-Za-z]+(?:\s+UNSIGNED)?(?:\([^)]*\))?)(\s*)(.*)$/is.exec(trimmed);
	if (!head) return null;
	const column: StudioColumn = {
		name: head[1]!,
		type_string: head[3]!,
		name_pad: head[2]!,
		type_pad: head[4]!.length > 0 ? head[4] : undefined,
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: [],
	};
	parse_modifiers(column, head[5]!.trim());
	return column;
}

/** Strip "-- ..." line comments outside of quoted strings, keeping other text intact. */
function strip_line_comments(input: string): string {
	let out = "";
	let in_string = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		const next = input[i + 1] ?? "";
		if (in_string) {
			out += ch;
			if (ch === "'") {
				if (next === "'") { out += next; i++; }
				else in_string = false;
			}
			continue;
		}
		if (ch === "'") { in_string = true; out += ch; continue; }
		if (ch === "-" && next === "-") {
			const eol = input.indexOf("\n", i);
			i = eol === -1 ? input.length : eol;
			continue;
		}
		out += ch;
	}
	return out;
}

function parse_modifiers(column: StudioColumn, input: string): void {
	let rest = strip_line_comments(input).trim();
	while (rest.length > 0) {
		const before = rest;
		if (/^NOT\s+NULL\b/i.test(rest)) {
			column.nullability = "not_null"; column.modifier_order.push("nullability"); rest = rest.replace(/^NOT\s+NULL\s*/i, "");
		} else if (/^NULL\b/i.test(rest)) {
			column.nullability = "null"; column.modifier_order.push("nullability"); rest = rest.replace(/^NULL\s*/i, "");
		} else if (/^PRIMARY\s+KEY\b/i.test(rest)) {
			column.is_primary_key = true; column.modifier_order.push("primary_key"); rest = rest.replace(/^PRIMARY\s+KEY\s*/i, "");
		} else if (/^AUTO_?INCREMENT\b/i.test(rest)) {
			column.is_auto_increment = true; column.modifier_order.push("auto_increment"); rest = rest.replace(/^AUTO_?INCREMENT\s*/i, "");
		} else if (/^DEFAULT\s+/i.test(rest)) {
			const after = rest.replace(/^DEFAULT\s+/i, "");
			if (after.startsWith("'")) {
				const [raw, end] = read_quoted_token(after, 0); column.default_value = raw; rest = after.slice(end + 1).trim();
			} else {
				const token = /^[^\s,]+/.exec(after)![0]; column.default_value = token; rest = after.slice(token.length).trim();
			}
			column.modifier_order.push("default");
		} else if (/^UNIQUE\b/i.test(rest)) {
			column.is_unique = true; column.modifier_order.push("unique"); rest = rest.replace(/^UNIQUE\s*/i, "");
		} else if (/^GENERATED\s+ALWAYS\s+AS\s*\(/i.test(rest)) {
			const generated_match = /^GENERATED\s+ALWAYS\s+AS(\s*)\(/i.exec(rest);
			const [inner, end] = read_paren_group(rest, rest.indexOf("("));
			column.is_generated = true; column.generated_expr = inner; column.generated_as_pad = generated_match?.[1] ?? " ";
			rest = rest.slice(end + 1).trim();
			const kind = /^(VIRTUAL|STORED)\b/i.exec(rest);
			if (kind) { column.generated_kind = kind[1]!.toUpperCase() as "VIRTUAL" | "STORED"; rest = rest.slice(kind[0].length).trim(); }
			column.modifier_order.push("generated");
		} else if (/^ON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i.test(rest)) {
			column.on_update_current_timestamp = true; column.modifier_order.push("on_update"); rest = rest.replace(/^ON\s+UPDATE\s+CURRENT_TIMESTAMP\s*/i, "");
		} else if (/^REFERENCES\b/i.test(rest)) {
			const parsed = parse_references(rest);
			if (parsed) { column.references = parsed.reference; column.modifier_order.push("references"); rest = rest.slice(parsed.consumed).trim(); }
		} else if (/^COMMENT\s+'/i.test(rest)) {
			const after = rest.replace(/^COMMENT\s+/i, "");
			const [raw, end] = read_quoted_token(after, 0);
			column.comment = raw.slice(1, -1).replace(/''/g, "'"); column.modifier_order.push("comment"); rest = after.slice(end + 1).trim();
		}
		if (rest === before) { column.extra_raw = rest; break; }
		rest = rest.trim();
	}
}

/** Parse a table-level [CONSTRAINT x] FOREIGN KEY(...) REFERENCES ... line. */
export function parse_table_foreign_key(line: string): TableForeignKey | null {
	const match = /^(?:CONSTRAINT\s+(\w+)\s+)?FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)(.*)$/i.exec(line.trim());
	if (!match) return null;
	const foreign_key: TableForeignKey = { column: match[2]!, ref_table: match[3]!, ref_column: match[4]! };
	if (match[1]) foreign_key.constraint_name = match[1];
	const on_update = /ON\s+UPDATE\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i.exec(match[5]!);
	const on_delete = /ON\s+DELETE\s+(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)/i.exec(match[5]!);
	if (on_update) foreign_key.on_update = on_update[1]!.toUpperCase();
	if (on_delete) foreign_key.on_delete = on_delete[1]!.toUpperCase();
	return foreign_key;
}

/** Parse table-level UNIQUE constraints, including MySQL UNIQUE KEY names. */
export function parse_table_unique_key(line: string): TableUniqueKey | null {
	const trimmed = line.trim();
	const named_key = /^UNIQUE\s+KEY\s+(\w+)\s*\(([^)]+)\)$/i.exec(trimmed);
	if (named_key) return { key_name: named_key[1]!, columns: parse_key_columns(named_key[2]!) };

	const constraint = /^CONSTRAINT\s+(\w+)\s+UNIQUE\s*\(([^)]+)\)$/i.exec(trimmed);
	if (constraint) return { constraint_name: constraint[1]!, columns: parse_key_columns(constraint[2]!) };

	const unique = /^UNIQUE\s*\(([^)]+)\)$/i.exec(trimmed);
	if (unique) return { columns: parse_key_columns(unique[1]!) };
	return null;
}

function parse_key_columns(value: string): string[] {
	return value.split(",").map((column) => column.trim());
}
