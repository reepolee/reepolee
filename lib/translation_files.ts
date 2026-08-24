import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { app_dir, APP_DIRS, PLATFORM_DIR, REEMAN_APP, REEQA_APP } from "$config/paths";
import { sort_object, type json_obj } from "$lib/translation_merge";

export interface FileTranslationRow {
	id: number;
	locale: string;
	namespace: string;
	key_path: string;
	translation: string;
}

const locale_filename_pattern = /^[a-z]{2,3}-[a-z0-9]{2,8}\.json$/;
let write_tail: Promise<void> = Promise.resolve();

/**
 * Roots walked for co-located `{locale}.json` files, in resolution order. The
 * shared platform tree is last: a namespace it owns (auth/*) exists in no app
 * tree, so order only decides which root wins a hypothetical collision.
 */
export function translation_roots(project_dir: string = process.cwd()): string[] {
	return [...APP_DIRS, PLATFORM_DIR].map((root) => app_dir(root, project_dir));
}

export function namespace_directory(namespace: string, project_dir: string = process.cwd()): string {
	if (!namespace || namespace === "root") return project_dir;

	const normalized_namespace = namespace.replaceAll("/", ".");
	const segments = normalized_namespace.split(".");
	const app_namespaces: Array<{ prefix: string; root: string; }> = [
		{ prefix: "reeman", root: app_dir(REEMAN_APP, project_dir) },
		{ prefix: "reeqa", root: app_dir(REEQA_APP, project_dir) },
	];

	for (const app_namespace of app_namespaces) {
		if (normalized_namespace === app_namespace.prefix) return app_namespace.root;
		if (normalized_namespace.startsWith(`${app_namespace.prefix}.`)) {
			const app_relative_segments = segments.slice(1);
			const candidate = join(app_namespace.root, ...app_relative_segments);
			if (existsSync(candidate)) return candidate;
			throw new Error(`Translation namespace has no route directory: ${namespace}`);
		}
	}

	for (const root of translation_roots(project_dir)) {
		const candidate = join(root, ...segments);
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(`Translation namespace has no route directory: ${namespace}`);
}

export function translation_file(namespace: string, locale: string, project_dir: string = process.cwd()): string {
	const directory = namespace_directory(namespace, project_dir);
	const filename = `${locale}.json`;
	const adjacent_file = join(directory, filename);
	const locale_file = join(directory, "locales", filename);
	const has_adjacent_file = existsSync(adjacent_file);
	const has_locale_file = existsSync(locale_file);

	if (has_adjacent_file && has_locale_file) {
		throw new Error(`Duplicate translation files for namespace "${namespace}" and locale "${locale}": ${adjacent_file}, ${locale_file}`);
	}

	if (has_locale_file) return locale_file;
	if (has_adjacent_file) return adjacent_file;
	if (existsSync(join(directory, "locales"))) return locale_file;
	return adjacent_file;
}

export function get_dotted(obj: json_obj, key_path: string): unknown {
	const parts = key_path.split(".");
	let cursor: unknown = obj;
	for (const part of parts) {
		if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = (cursor as json_obj)[part];
	}
	return cursor;
}

export function set_dotted(obj: json_obj, key_path: string, value: string): void {
	const parts = key_path.split(".");
	let cursor = obj;
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index]!;
		const next = cursor[part];
		if (next === null || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
		cursor = cursor[part] as json_obj;
	}
	cursor[parts[parts.length - 1]!] = value;
}

export function delete_dotted(obj: json_obj, key_path: string): boolean {
	const parts = key_path.split(".");
	const parents: Array<{ obj: json_obj; key: string; }> = [];
	let cursor = obj;
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index]!;
		const next = cursor[part];
		if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
		parents.push({ obj: cursor, key: part });
		cursor = next as json_obj;
	}

	const leaf = parts[parts.length - 1]!;
	if (!(leaf in cursor)) return false;
	delete cursor[leaf];

	for (let index = parents.length - 1; index >= 0; index--) {
		const parent = parents[index]!;
		const child = parent.obj[parent.key];
		if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
			delete parent.obj[parent.key];
		} else {
			break;
		}
	}
	return true;
}

export function flatten_translation_object(obj: json_obj, prefix: string = ""): Array<{ key_path: string; translation: string; }> {
	const rows: Array<{ key_path: string; translation: string; }> = [];
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		const key_path = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const nested_rows = flatten_translation_object(value, key_path);
			rows.push(...nested_rows);
		} else {
			rows.push({ key_path, translation: String(value ?? "") });
		}
	}
	return rows;
}

export async function read_namespace_file(namespace: string, locale: string, project_dir: string = process.cwd()): Promise<json_obj> {
	const file = translation_file(namespace, locale, project_dir);
	if (!existsSync(file)) return {};
	return await Bun.file(file).json() as json_obj;
}

export async function write_namespace_file(namespace: string, locale: string, obj: json_obj, project_dir: string = process.cwd()): Promise<void> {
	const file = translation_file(namespace, locale, project_dir);
	const sorted = sort_object(obj);
	const serialized = JSON.stringify(sorted, null, "\t") + "\n";
	await mkdir(dirname(file), { recursive: true });
	await Bun.write(file, serialized);
}

export async function serialize_translation_write<T>(operation: () => Promise<T>): Promise<T> {
	const previous = write_tail;
	let release: () => void = () => {};
	write_tail = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

export async function upsert_file_translation(locale: string, namespace: string, key_path: string, translation: string, project_dir: string = process.cwd()): Promise<void> {
	await serialize_translation_write(async () => {
		const obj = await read_namespace_file(namespace, locale, project_dir);
		set_dotted(obj, key_path, translation);
		await write_namespace_file(namespace, locale, obj, project_dir);
	});
}

export async function delete_file_translation(locale: string, namespace: string, key_path: string, project_dir: string = process.cwd()): Promise<boolean> {
	return await serialize_translation_write(async () => {
		const obj = await read_namespace_file(namespace, locale, project_dir);
		const deleted = delete_dotted(obj, key_path);
		if (deleted) await write_namespace_file(namespace, locale, obj, project_dir);
		return deleted;
	});
}

async function walk_translation_files(root: string): Promise<string[]> {
	const files: string[] = [];
	if (!existsSync(root)) return files;
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const full_path = join(root, entry.name);
		if (entry.isDirectory()) {
			const nested_files = await walk_translation_files(full_path);
			files.push(...nested_files);
		} else if (locale_filename_pattern.test(entry.name)) {
			files.push(full_path);
		}
	}
	return files;
}

function is_route_directory(directory: string): boolean {
	return existsSync(join(directory, "index.ree")) || existsSync(join(directory, "index.ts"));
}

export interface ListedTranslationFile {
	file: string;
	locale: string;
	namespace: string;
}

export interface ShadowedTranslationFile extends ListedTranslationFile {
	/** Canonical file for the same (namespace, locale) that supersedes this one. */
	superseded_by: string;
}

/**
 * Scan every app root for locale files, mirroring `namespace_directory()`'s
 * namespace mapping. Reeman and ReeQA files are prefixed with `reeman.` and
 * `reeqa.` so their route namespaces cannot collide with generated main-app
 * CRUD namespaces. Canonical files are still deduplicated within one mapped
 * namespace, while genuine same-directory duplicates remain fatal.
 * Genuine same-directory duplicates (adjacent file + `locales/` subdir) stay
 * fatal - `translation_file()` throws for them too.
 */
async function scan_translation_files(project_dir: string): Promise<{ found: ListedTranslationFile[]; shadowed: ShadowedTranslationFile[]; }> {
	const found: ListedTranslationFile[] = [];
	const shadowed: ShadowedTranslationFile[] = [];
	const found_by_namespace_locale = new Map<string, { file: string; root: string | null; }>();
	const add_file = (file: string, locale: string, namespace: string, root: string | null): void => {
		const key = `${namespace}\u0000${locale}`;
		const existing = found_by_namespace_locale.get(key);
		if (existing) {
			if (existing.root !== root) {
				console.warn(`Shadowed translation file for namespace "${namespace}" and locale "${locale}": ${file} is superseded by ${existing.file} from a higher-priority app tree and will be ignored.`);
				shadowed.push({ file, locale, namespace, superseded_by: existing.file });
				return;
			}
			throw new Error(`Duplicate translation files for namespace "${namespace}" and locale "${locale}": ${existing.file}, ${file}`);
		}
		found_by_namespace_locale.set(key, { file, root });
		found.push({ file, locale, namespace });
	};

	for (const root of translation_roots(project_dir)) {
		const files = await walk_translation_files(root);
		for (const file of files) {
			const directory = dirname(file);
			const is_locale_directory = basename(directory) === "locales" && !is_route_directory(directory);
			const namespace_directory_path = is_locale_directory ? dirname(directory) : directory;
			const relative_directory = relative(root, namespace_directory_path);
			const relative_namespace = relative_directory ? relative_directory.split(sep).join(".") : "";
			const app_namespace = root === app_dir(REEMAN_APP, project_dir)
				? "reeman"
				: root === app_dir(REEQA_APP, project_dir) ? "reeqa" : "";
			const namespace = relative_namespace
				? (app_namespace ? `${app_namespace}.${relative_namespace}` : relative_namespace)
				: (app_namespace || "root");
			const filename = file.slice(directory.length + 1);
			add_file(file, filename.slice(0, -5), namespace, root);
		}
	}

	const root_entries = await readdir(project_dir, { withFileTypes: true });
	for (const entry of root_entries) {
		if (entry.isFile() && locale_filename_pattern.test(entry.name)) {
			add_file(join(project_dir, entry.name), entry.name.slice(0, -5), "root", null);
		}
	}

	const root_locales_directory = join(project_dir, "locales");
	if (existsSync(root_locales_directory)) {
		const root_locale_entries = await readdir(root_locales_directory, { withFileTypes: true });
		for (const entry of root_locale_entries) {
			if (entry.isFile() && locale_filename_pattern.test(entry.name)) {
				add_file(join(root_locales_directory, entry.name), entry.name.slice(0, -5), "root", null);
			}
		}
	}
	return { found, shadowed };
}

export async function list_translation_files(project_dir: string = process.cwd()): Promise<ListedTranslationFile[]> {
	const { found } = await scan_translation_files(project_dir);
	return found;
}

/**
 * Files found on disk that are shadowed by a higher-priority app tree's file
 * for the same (namespace, locale) and therefore ignored. Surfaces the
 * console.warn emitted during scanning so the UI can show users why a locale
 * file they see on disk has no effect.
 */
export async function list_shadowed_translation_files(project_dir: string = process.cwd()): Promise<ShadowedTranslationFile[]> {
	const { shadowed } = await scan_translation_files(project_dir);
	return shadowed;
}

export async function read_all_translation_rows(project_dir: string = process.cwd()): Promise<FileTranslationRow[]> {
	const files = await list_translation_files(project_dir);
	files.sort((left, right) => left.file.localeCompare(right.file));
	const rows: FileTranslationRow[] = [];
	let id = 1;
	for (const item of files) {
		const obj = await Bun.file(item.file).json() as json_obj;
		const flattened = flatten_translation_object(obj);
		for (const row of flattened) {
			rows.push({ id, locale: item.locale, namespace: item.namespace, key_path: row.key_path, translation: row.translation });
			id++;
		}
	}
	return rows;
}
