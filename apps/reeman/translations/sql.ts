import { unlink } from "node:fs/promises";

import {
	delete_file_translation,
	list_translation_files,
	read_all_translation_rows,
	upsert_file_translation,
} from "$lib/translation_files";

export interface TranslationRow {
	id: number;
	locale: string;
	namespace: string;
	key_path: string;
	translation: string;
}

export async function get_key_by_id(id: string): Promise<{ namespace: string; key_path: string; values: Record<string, string>; } | undefined> {
	const delimiter_index = id.indexOf("::");
	if (delimiter_index < 0) return undefined;
	const namespace = id.slice(0, delimiter_index);
	const key_path = id.slice(delimiter_index + 2);
	const rows = await read_all_translation_rows();
	const matching_rows = rows.filter((row) => row.namespace === namespace && row.key_path === key_path);
	if (matching_rows.length === 0) return undefined;

	const values: Record<string, string> = {};
	for (const row of matching_rows) values[row.locale] = row.translation;
	return { namespace, key_path, values };
}

export async function delete_key(namespace: string, key_path: string): Promise<number> {
	const rows = await read_all_translation_rows();
	const locales = rows.filter((row) => row.namespace === namespace && row.key_path === key_path).map((row) => row.locale);
	let deleted = 0;
	for (const locale of locales) {
		if (await delete_file_translation(locale, namespace, key_path)) deleted++;
	}
	return deleted;
}

export async function delete_translation(locale: string, namespace: string, key_path: string): Promise<number> {
	const deleted = await delete_file_translation(locale, namespace, key_path);
	return deleted ? 1 : 0;
}

export async function upsert_translation(locale: string, namespace: string, key_path: string, translation: string): Promise<void> {
	await upsert_file_translation(locale, namespace, key_path, translation);
}

export async function get_namespaces(): Promise<string[]> {
	const rows = await read_all_translation_rows();
	return [...new Set(rows.map((row) => row.namespace))].sort();
}

export async function get_all_locales(): Promise<string[]> {
	const rows = await read_all_translation_rows();
	return [...new Set(rows.map((row) => row.locale))].sort();
}

export interface NamespaceGroup {
	namespace: string;
	parent_path: string;
}

export async function get_namespace_groups(): Promise<NamespaceGroup[]> {
	const rows = await read_all_translation_rows();
	const seen = new Set<string>();
	const groups: NamespaceGroup[] = [];
	for (const row of rows) {
		if (row.key_path.endsWith("_placeholder")) continue;
		const last_dot = row.key_path.lastIndexOf(".");
		const parent_path = last_dot >= 0 ? row.key_path.slice(0, last_dot) : "";
		const group_key = `${row.namespace}::${parent_path}`;
		if (seen.has(group_key)) continue;
		seen.add(group_key);
		groups.push({ namespace: row.namespace, parent_path });
	}
	groups.sort((left, right) => left.namespace.localeCompare(right.namespace) || left.parent_path.localeCompare(right.parent_path));
	return groups;
}

export async function get_all_translations(namespace_filter: string = ""): Promise<TranslationRow[]> {
	const rows = await read_all_translation_rows();
	if (!namespace_filter) return rows;
	return rows.filter((row) => row.namespace === namespace_filter);
}

function belongs_to_group(key_path: string, parent_path: string): boolean {
	if (!parent_path) return true;
	return key_path === parent_path || key_path.startsWith(`${parent_path}.`);
}

function matches_multi_group(row: TranslationRow, groups: { namespace: string; parent_path: string; }[]): boolean {
	return groups.some((group) => row.namespace === group.namespace && belongs_to_group(row.key_path, group.parent_path));
}

function filter_rows(
	rows: TranslationRow[],
	namespace_filter: string,
	group_filter: string,
	query: string,
	multi_ns_groups: { namespace: string; parent_path: string; }[],
	negate_multi: boolean,
): TranslationRow[] {
	const normalized_query = query.toLowerCase();
	return rows.filter((row) => {
		if (multi_ns_groups.length > 0) {
			const group_match = matches_multi_group(row, multi_ns_groups);
			if (negate_multi ? group_match : !group_match) return false;
		} else {
			if (namespace_filter && row.namespace !== namespace_filter) return false;
			if (group_filter && !belongs_to_group(row.key_path, group_filter)) return false;
		}
		if (!normalized_query) return true;
		return row.namespace.toLowerCase().includes(normalized_query)
			|| row.key_path.toLowerCase().includes(normalized_query)
			|| row.translation.toLowerCase().includes(normalized_query);
	});
}

function distinct_key_rows(rows: TranslationRow[]): Array<{ namespace: string; key_path: string; }> {
	const keys = new Map<string, { namespace: string; key_path: string; }>();
	for (const row of rows) {
		const map_key = `${row.namespace}::${row.key_path}`;
		if (!keys.has(map_key)) keys.set(map_key, { namespace: row.namespace, key_path: row.key_path });
	}
	return [...keys.values()];
}

export async function count_translation_rows(
	namespace_filter: string = "",
	group_filter: string = "",
	query: string = "",
	multi_ns_groups: { namespace: string; parent_path: string; }[] = [],
	negate_multi: boolean = false,
): Promise<number> {
	const rows = await read_all_translation_rows();
	const filtered_rows = filter_rows(rows, namespace_filter, group_filter, query, multi_ns_groups, negate_multi);
	return distinct_key_rows(filtered_rows).length;
}

export async function get_translations_page(
	namespace_filter: string = "",
	group_filter: string = "",
	query: string = "",
	multi_ns_groups: { namespace: string; parent_path: string; }[] = [],
	negate_multi: boolean = false,
	offset: number,
	limit: number,
	sort_field: string = "namespace",
	sort_dir: "asc" | "desc" = "asc",
): Promise<TranslationRow[]> {
	const rows = await read_all_translation_rows();
	const filtered_rows = filter_rows(rows, namespace_filter, group_filter, query, multi_ns_groups, negate_multi);
	const keys = distinct_key_rows(filtered_rows);
	const direction = sort_dir === "desc" ? -1 : 1;
	keys.sort((left, right) => {
		const left_value = sort_field === "parent_path" ? left.key_path : left.namespace;
		const right_value = sort_field === "parent_path" ? right.key_path : right.namespace;
		const comparison = left_value.localeCompare(right_value) || left.namespace.localeCompare(right.namespace) || left.key_path.localeCompare(right.key_path);
		return comparison * direction;
	});
	const page_keys = keys.slice(offset, offset + limit);
	const selected = new Set(page_keys.map((key) => `${key.namespace}::${key.key_path}`));
	return rows.filter((row) => selected.has(`${row.namespace}::${row.key_path}`));
}

export async function delete_groups(groups: { namespace: string; parent_path: string; }[]): Promise<number> {
	const rows = await read_all_translation_rows();
	const targets = rows.filter((row) => groups.some((group) => {
		if (row.namespace !== group.namespace) return false;
		if (group.parent_path) return row.key_path.startsWith(`${group.parent_path}.`);
		return !row.key_path.includes(".");
	}));
	let deleted = 0;
	for (const row of targets) {
		if (await delete_file_translation(row.locale, row.namespace, row.key_path)) deleted++;
	}
	return deleted;
}

export async function delete_namespace(namespace: string): Promise<number> {
	const rows = await read_all_translation_rows();
	const deleted_count = rows.filter((row) => row.namespace === namespace).length;
	const files = await list_translation_files();
	const namespace_files = files.filter((item) => item.namespace === namespace);
	for (const item of namespace_files) await unlink(item.file);
	return deleted_count;
}
