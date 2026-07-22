/**
 * Translation helpers - extracted from index.ts for file-size compliance.
 */

// Types

export interface TranslationRow {
	id: number;
	lang: string;
	namespace: string;
	key_path: string;
	translation: string;
}

export interface GroupInfo {
	namespace: string;
	parent_path: string;
	child_keys: string[];
	languages: string[];
	keys: { key_path: string; child_key: string; values: Record<string, string>; }[];
}

// Path helpers

export function parent_path(key_path: string): string {
	const last_dot = key_path.lastIndexOf(".");
	return last_dot >= 0 ? key_path.slice(0, last_dot) : "";
}

export function child_key(key_path: string): string {
	const last_dot = key_path.lastIndexOf(".");
	return last_dot >= 0 ? key_path.slice(last_dot + 1) : key_path;
}

// Key-level flatten

export interface KeyRow {
	namespace: string;
	parent_path: string;
	key_path: string;
	child_key: string;
	values: Record<string, string>;
}

/**
 * Flatten raw TranslationRow[] into one entry per distinct key_path,
 * with all language values rolled up. The result is sorted by namespace, key_path.
 */
export function flatten_to_keys(rows: TranslationRow[]): KeyRow[] {
	const real = rows.filter((r) => !r.key_path.endsWith("_placeholder"));

	// Group by (namespace, key_path)
	const value_map = new Map();
	const key_order: string[] = [];
	for (const r of real) {
		const k = `${r.namespace}::${r.key_path}`;
		if (!value_map.has(k)) {
			value_map.set(k, {});
			key_order.push(k);
		}
		value_map.get(k)![r.lang] = r.translation;
	}

	return key_order.map((k) => {
		const delim = k.indexOf("::");
		const ns = k.slice(0, delim);
		const kp = k.slice(delim + 2);
		return {
			namespace: ns,
			parent_path: parent_path(kp),
			key_path: kp,
			child_key: child_key(kp),
			values: value_map.get(k)!,
		};
	});
}

export interface CollapsibleSection {
	namespace: string;
	parent_path: string;
	key_count: number;
	rows: KeyRow[];
}

/**
 * Group flat KeyRow[] into collapsible sections by (namespace, parent_path).
 * Each section contains all keys that share the same namespace + parent_path.
 */
export function group_into_sections(keys: KeyRow[]): CollapsibleSection[] {
	const map = new Map();
	for (const k of keys) {
		const key = `${k.namespace}::${k.parent_path}`;
		if (!map.has(key)) map.set(key, []);
		map.get(key)?.push(k);
	}

	return Array.from(map.entries()).map(([key, rows]) => {
		const delim = key.indexOf("::");
		return {
			namespace: key.slice(0, delim),
			parent_path: key.slice(delim + 2),
			key_count: rows.length,
			rows,
		};
	});
}

// Legacy grouping (kept for edit page)

export function group_translations(rows: TranslationRow[]): GroupInfo[] {
	// Filter out placeholder entries only
	const real = rows.filter((r) => !r.key_path.endsWith("_placeholder"));

	// Group by namespace + parent_path
	const group_map = new Map();
	for (const r of real) {
		const pp = parent_path(r.key_path);
		const key = `${r.namespace}::${pp}`;
		if (!group_map.has(key)) group_map.set(key, []);
		group_map.get(key)?.push(r);
	}

	const result: GroupInfo[] = [];
	for (const [key, items] of group_map) {
		const delim = key.indexOf("::");
		const ns = key.slice(0, delim);
		const pp = key.slice(delim + 2);

		const child_keys_set = new Set();
		const langs_set = new Set();
		const value_map: Record<string, Record<string, string>> = {};

		for (const r of items) {
			child_keys_set.add(r.key_path);
			langs_set.add(r.lang);
			if (!value_map[r.key_path]) value_map[r.key_path] = {};
			value_map[r.key_path][r.lang] = r.translation;
		}

		const sorted_child_keys = Array.from(child_keys_set).sort();
		const sorted_langs = Array.from(langs_set).sort();

		result.push({
			namespace: ns,
			parent_path: pp,
			child_keys: sorted_child_keys,
			languages: sorted_langs,
			keys: sorted_child_keys.map((ck) => ({
				key_path: ck,
				child_key: child_key(ck),
				values: value_map[ck] || {},
			})),
		});
	}

	result.sort((a, b) => {
		if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
		return a.parent_path.localeCompare(b.parent_path);
	});

	return result;
}

// Namespace templates for guided creation

export interface TemplateKey {
	[key: string]: string;
}

export interface TemplateGroup {
	id: string;
	label: string;
	description: string;
	keys: TemplateKey;
}

export const namespace_templates: TemplateGroup[] = [
	{
		id: "actions",
		label: "actions",
		description: "Save, Cancel, Delete, Edit, Back",
		keys: {
			"actions.save": "Save",
			"actions.cancel": "Cancel",
			"actions.delete": "Delete",
			"actions.edit": "Edit",
			"actions.back": "Back",
		},
	},
	{
		id: "ui",
		label: "ui",
		description: "Title, labels, headings",
		keys: { "ui.title": "Title", "ui.no_records": "No records found." },
	},
	{
		id: "messages",
		label: "messages",
		description: "Status, confirmations, notifications",
		keys: { "messages.record_updated": "Record updated", "messages.confirm_delete": "Are you sure?" },
	},
	{
		id: "labels",
		label: "labels",
		description: "Field labels",
		keys: { "labels.name": "Name", "labels.email": "Email" },
	},
	{
		id: "errors",
		label: "errors",
		description: "Validation error messages",
		keys: { "errors.required": "This field is required.", "errors.invalid": "Invalid value." },
	},
	{
		id: "selectors",
		label: "selectors",
		description: "Select/dropdown options",
		keys: { "selectors.all": "All", "selectors.yes": "Yes", "selectors.no": "No" },
	},
	{
		id: "search",
		label: "search",
		description: "Search input labels",
		keys: { "search.search_term": "Search...", "search.submit": "Search" },
	},
];
