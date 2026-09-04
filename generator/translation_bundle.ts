import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { normalize_locale } from "$lib/locale";
import { default_locale } from "$config/supported_locales";
import { flatten_translation_object, get_dotted, list_translation_files, set_dotted } from "$lib/translation_files";
import { is_object, sort_object, type json_obj } from "$lib/translation_merge";

export const TRANSLATION_ARCHIVE_FORMAT = "reepolee-translations-v2";
export const TRANSLATION_ARCHIVE_DIR = "locales-archive";

export interface TranslationMemoryEntry { source: string; placeholders: string[]; translation: string; }
export interface TranslationArchive { format: typeof TRANSLATION_ARCHIVE_FORMAT; source_locale: typeof default_locale; target_locale: string; routes: Record<string, Record<string, TranslationMemoryEntry>>; tables: Record<string, Record<string, TranslationMemoryEntry>>; }
export interface ArchivedTranslationBundle { code: string; file_count: number; is_current: boolean; }

let write_tail: Promise<void> = Promise.resolve();

function placeholders(value: string): string[] { return value.match(/\{[a-zA-Z_][a-zA-Z0-9_.]*\}/g)?.sort() ?? []; }
function posix_relative(project_dir: string, file: string): string { return relative(project_dir, file).split(sep).join("/"); }
function empty_archive(locale: string): TranslationArchive { return { format: TRANSLATION_ARCHIVE_FORMAT, source_locale: default_locale, target_locale: locale, routes: {}, tables: {} }; }
function valid_entry(value: unknown): value is TranslationMemoryEntry { return is_object(value) && typeof value.source === "string" && typeof value.translation === "string" && Array.isArray(value.placeholders) && value.placeholders.every((item) => typeof item === "string"); }
function valid_entries(value: unknown): value is Record<string, TranslationMemoryEntry> { return is_object(value) && Object.values(value).every(valid_entry); }
function valid_archive(value: unknown): value is TranslationArchive { return is_object(value) && value.format === TRANSLATION_ARCHIVE_FORMAT && value.source_locale === default_locale && typeof value.target_locale === "string" && is_object(value.routes) && Object.values(value.routes).every(valid_entries) && is_object(value.tables) && Object.values(value.tables).every(valid_entries); }

async function default_locale_sources(project_dir: string): Promise<Array<{ path: string; translations: json_obj; }>> {
	const files = await list_translation_files(project_dir);
	const sources = files.filter((item) => item.locale === default_locale);
	sources.sort((left, right) => left.file.localeCompare(right.file));
	return await Promise.all(sources.map(async (item) => ({ path: posix_relative(project_dir, item.file), translations: await Bun.file(item.file).json() as json_obj })));
}

function record_entries(source: json_obj, translated: json_obj): Record<string, TranslationMemoryEntry> {
	const entries: Record<string, TranslationMemoryEntry> = {};
	for (const row of flatten_translation_object(source)) {
		const translation = get_dotted(translated, row.key_path);
		if (typeof translation !== "string" || translation.startsWith("::missing:: ") || JSON.stringify(placeholders(row.translation)) !== JSON.stringify(placeholders(translation))) continue;
		entries[row.key_path] = { source: row.translation, placeholders: placeholders(row.translation), translation };
	}
	return entries;
}

async function write_json_atomic(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temp_file = `${file}.tmp-${crypto.randomUUID()}`;
	const backup_file = `${file}.bak-${crypto.randomUUID()}`;
	const had_original = existsSync(file);
	await Bun.write(temp_file, `${JSON.stringify(sort_object(value as json_obj), null, "\t")}\n`);
	try { if (had_original) await rename(file, backup_file); await rename(temp_file, file); if (had_original) await rm(backup_file, { force: true }); }
	catch (error) { await rm(temp_file, { force: true }); if (had_original && existsSync(backup_file)) await rename(backup_file, file); throw error; }
}

export function archive_bundle_file(locale: string, project_dir: string = process.cwd()): string { return join(project_dir, TRANSLATION_ARCHIVE_DIR, `${normalize_locale(locale)}.json`); }

export async function read_translation_archive(locale: string, project_dir: string = process.cwd()): Promise<TranslationArchive> {
	const normalized_locale = normalize_locale(locale);
	const file = archive_bundle_file(normalized_locale, project_dir);
	if (!existsSync(file)) return empty_archive(normalized_locale);
	try {
		const parsed = await Bun.file(file).json();
		if (valid_archive(parsed)) return parsed;
		throw new Error("unsupported format");
	} catch (error) { console.warn(`⚠ Translation archive ignored for ${normalized_locale}: ${error instanceof Error ? error.message : error}`); return empty_archive(normalized_locale); }
}

export async function update_translation_archive(locale: string, update: (archive: TranslationArchive) => void, project_dir: string = process.cwd()): Promise<void> {
	const normalized_locale = normalize_locale(locale);
	const previous = write_tail;
	let release: () => void = () => {};
	write_tail = new Promise<void>((resolve) => { release = resolve; });
	await previous;
	try { const archive = await read_translation_archive(normalized_locale, project_dir); update(archive); await write_json_atomic(archive_bundle_file(normalized_locale, project_dir), archive); } finally { release(); }
}

export async function save_route_translation_memory(source_path: string, locale: string, source: json_obj, translated: json_obj, project_dir: string = process.cwd()): Promise<void> {
	if (locale === default_locale) return;
	const entries = record_entries(source, translated);
	if (Object.keys(entries).length > 0) await update_translation_archive(locale, (archive) => { archive.routes[source_path] = { ...archive.routes[source_path], ...entries }; }, project_dir);
}

function apply_entries(entries: Record<string, TranslationMemoryEntry> | undefined, source: json_obj, target: json_obj): json_obj {
	if (!entries) return target;
	const result = sort_object(target);
	for (const row of flatten_translation_object(source)) {
		const cached = entries[row.key_path];
		const current = get_dotted(result, row.key_path);
		if (typeof current !== "string" || !current.startsWith("::missing:: ") || !cached || cached.source !== row.translation || JSON.stringify(cached.placeholders) !== JSON.stringify(placeholders(row.translation)) || JSON.stringify(placeholders(cached.translation)) !== JSON.stringify(placeholders(row.translation))) continue;
		set_dotted(result, row.key_path, cached.translation);
	}
	return result;
}

export async function apply_route_translation_memory(source_path: string, locale: string, source: json_obj, target: json_obj, project_dir: string = process.cwd()): Promise<json_obj> { return locale === default_locale ? target : apply_entries((await read_translation_archive(locale, project_dir)).routes[source_path], source, target); }
export async function save_table_translation_memory(table: string, locale: string, source: json_obj, translated: json_obj, project_dir: string = process.cwd()): Promise<void> { if (locale !== default_locale) { const entries = record_entries(source, translated); if (Object.keys(entries).length > 0) await update_translation_archive(locale, (archive) => { archive.tables[table] = { ...archive.tables[table], ...entries }; }, project_dir); } }
export async function apply_table_translation_memory(table: string, locale: string, source: json_obj, target: json_obj, project_dir: string = process.cwd()): Promise<json_obj> { return locale === default_locale ? target : apply_entries((await read_translation_archive(locale, project_dir)).tables[table], source, target); }

export async function create_translation_bundle(target_locale: string | null = null, project_dir: string = process.cwd()): Promise<TranslationArchive> {
	const locale = target_locale === null ? default_locale : normalize_locale(target_locale);
	const archive = empty_archive(locale);
	for (const source of await default_locale_sources(project_dir)) archive.routes[source.path] = record_entries(source.translations, source.translations);
	return archive;
}
export async function export_translation_bundle(output_file: string, target_locale: string | null = null, project_dir: string = process.cwd()): Promise<TranslationArchive> { const bundle = await create_translation_bundle(target_locale, project_dir); await write_json_atomic(isAbsolute(output_file) ? output_file : resolve(project_dir, output_file), bundle); return bundle; }

export async function archive_translation_bundle_data(input: unknown, project_dir: string = process.cwd()): Promise<TranslationArchive> {
	if (!valid_archive(input)) throw new Error("Translation bundle must use the reepolee-translations-v2 archive format.");
	const locale = normalize_locale(input.target_locale);
	await update_translation_archive(locale, (archive) => {
		for (const [path, entries] of Object.entries(input.routes)) archive.routes[path] = { ...archive.routes[path], ...entries };
		for (const [table, entries] of Object.entries(input.tables)) archive.tables[table] = { ...archive.tables[table], ...entries };
	}, project_dir);
	return await read_translation_archive(locale, project_dir);
}
export async function archive_translation_bundle(bundle_file: string, project_dir: string = process.cwd()): Promise<TranslationArchive> { const file = isAbsolute(bundle_file) ? bundle_file : resolve(project_dir, bundle_file); if (!existsSync(file)) throw new Error(`Translation bundle not found: ${bundle_file}`); return await archive_translation_bundle_data(await Bun.file(file).json(), project_dir); }
export async function list_archived_translation_bundles(project_dir: string = process.cwd()): Promise<ArchivedTranslationBundle[]> { const directory = join(project_dir, TRANSLATION_ARCHIVE_DIR); if (!existsSync(directory)) return []; const result: ArchivedTranslationBundle[] = []; for (const entry of await readdir(directory, { withFileTypes: true })) { if (!entry.isFile() || !/^[a-z]{2,3}-[a-z0-9]{2,8}\.json$/.test(entry.name)) continue; const code = entry.name.slice(0, -5); const archive = await read_translation_archive(code, project_dir); result.push({ code, file_count: Object.keys(archive.routes).length, is_current: true }); } return result.sort((left, right) => left.code.localeCompare(right.code)); }
export async function install_archived_translation_bundle(locale: string, project_dir: string = process.cwd()): Promise<TranslationArchive> {
	const archive = await read_translation_archive(locale, project_dir);
	for (const source of await default_locale_sources(project_dir)) {
		const missing: json_obj = {};
		for (const row of flatten_translation_object(source.translations)) set_dotted(missing, row.key_path, `::missing:: ${row.translation}`);
		const translated = apply_entries(archive.routes[source.path], source.translations, missing);
		if (Object.keys(archive.routes[source.path] ?? {}).length === 0) continue;
		const source_suffix = `${default_locale}.json`;
		const target_suffix = `${archive.target_locale}.json`;
		const target_path = source.path.endsWith(source_suffix)
			? `${source.path.slice(0, -source_suffix.length)}${target_suffix}`
			: source.path;
		const file = resolve(project_dir, ...target_path.split("/"));
		await write_json_atomic(file, translated);
	}
	return archive;
}
/** One-time v1-to-v2 content migration. Runtime code reads v2 only. */
