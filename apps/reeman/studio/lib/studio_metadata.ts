/** Studio-only metadata embedded as line comments at the end of a DDL file. */

import type { StudioStatement } from "./types";

const BEGIN_MARKER = "-- reepolee-studio:begin v1";
const END_MARKER = "-- reepolee-studio:end";

export interface StudioMetadata {
	version: 1;
	domain_map: Record<string, Record<string, string>>;
}

export interface ExtractedStudioMetadata {
	sql: string;
	metadata: StudioMetadata | null;
}

export function extract_studio_metadata(source: string): ExtractedStudioMetadata {
	const marker_index = source.lastIndexOf(BEGIN_MARKER);
	if (marker_index === -1 || (marker_index > 0 && source[marker_index - 1] !== "\n")) {
		return { sql: source, metadata: null };
	}

	const sql = source.slice(0, marker_index);
	const footer = source.slice(marker_index);
	const end_index = footer.indexOf(END_MARKER);
	if (end_index === -1) return { sql, metadata: null };

	try {
		const json_lines = footer.slice(BEGIN_MARKER.length, end_index).split(/\r?\n/).slice(1);
		const json = json_lines.map(strip_comment_prefix).join("\n").trim();
		const parsed = JSON.parse(json) as Partial<StudioMetadata>;
		if (parsed.version !== 1 || !is_domain_map(parsed.domain_map)) return { sql, metadata: null };
		return { sql, metadata: parsed as StudioMetadata };
	} catch {
		return { sql, metadata: null };
	}
}

export function append_studio_metadata(source: string, statements: StudioStatement[]): string {
	const metadata = metadata_from_statements(statements);
	const json = JSON.stringify(metadata, null, 2);
	const comments = json.split("\n").map((line) => `-- ${line}`).join("\n");
	const separator = source.endsWith("\n") ? "" : "\n";
	return `${source}${separator}${BEGIN_MARKER}\n${comments}\n${END_MARKER}\n`;
}

export function apply_studio_metadata(statements: StudioStatement[], metadata: StudioMetadata | null): void {
	if (!metadata) return;
	for (const statement of statements) {
		if (statement.kind !== "create_table" || !statement.table) continue;
		const table_map = metadata.domain_map[statement.table.name];
		if (!table_map) continue;
		for (const column of statement.table.columns) {
			const domain_type = table_map[column.name];
			if (domain_type) column.domain_type = domain_type;
		}
	}
}

function metadata_from_statements(statements: StudioStatement[]): StudioMetadata {
	const domain_map: Record<string, Record<string, string>> = {};
	for (const statement of statements) {
		if (statement.kind !== "create_table" || !statement.table) continue;
		const table_map: Record<string, string> = {};
		for (const column of statement.table.columns) {
			if (column.domain_type) table_map[column.name] = column.domain_type;
		}
		if (Object.keys(table_map).length > 0) domain_map[statement.table.name] = table_map;
	}
	return { version: 1, domain_map };
}

function strip_comment_prefix(line: string): string {
	if (line === "") return "";
	if (line.startsWith("-- ")) return line.slice(3);
	if (line === "--") return "";
	throw new Error("Invalid Studio metadata comment");
}

function is_domain_map(value: unknown): value is Record<string, Record<string, string>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const columns of Object.values(value)) {
		if (!columns || typeof columns !== "object" || Array.isArray(columns)) return false;
		if (Object.values(columns).some((domain_type) => typeof domain_type !== "string")) return false;
	}
	return true;
}
