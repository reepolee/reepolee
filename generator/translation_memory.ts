import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { MAIN_APP } from "$config/paths";
import { default_locale, locales } from "$config/supported_locales";
import { list_translation_files, namespace_directory, translation_file } from "$lib/translation_files";
import { clean_for_translation, type json_obj } from "$lib/translation_merge";

import { apply_route_translation_memory, apply_table_translation_memory, create_translation_bundle, save_route_translation_memory, save_table_translation_memory, update_translation_archive } from "./translation_bundle";

/** CRUD memory is table-keyed so it survives regeneration under a new route path. */
export async function save_translation_memory(table_name: string, locale: string, source: json_obj, translated: json_obj, project_dir: string = process.cwd()): Promise<void> {
	if (!table_name || locale === default_locale) return;
	await save_table_translation_memory(table_name, locale, source, translated, project_dir);
}

export async function apply_translation_memory(table_name: string, locale: string, source: json_obj, target: json_obj, project_dir: string = process.cwd()): Promise<json_obj> {
	if (!table_name || locale === default_locale) return target;
	return await apply_table_translation_memory(table_name, locale, source, target, project_dir);
}

/** Route memory applies to every namespace, including main, Reeman, ReeQA, platform, and root. */
export async function apply_route_memory(namespace: string, locale: string, source: json_obj, target: json_obj, project_dir: string = process.cwd()): Promise<json_obj> {
	if (locale === default_locale) return target;
	const source_path = relative(project_dir, translation_file(namespace, default_locale, project_dir)).split(sep).join("/");
	return await apply_route_translation_memory(source_path, locale, source, target, project_dir);
}

/**
 * Snapshot every current co-located translation into the per-locale archive.
 * This is safe to run repeatedly: matching route/table leaves are merged.
 */
export async function archive_live_translation_memory(project_dir: string = process.cwd()): Promise<{ routes: number; tables: number; }> {
	const files = await list_translation_files(project_dir);
	const by_namespace_locale = new Map(files.map((item) => [`${item.namespace}\u0000${item.locale}`, item]));
	let routes = 0;
	let tables = 0;
	for (const english of files.filter((item) => item.locale === default_locale)) {
		const source = await Bun.file(english.file).json() as json_obj;
		const source_path = relative(project_dir, english.file).split(sep).join("/");
		const table_name = await table_for_translation_namespace(english.namespace, project_dir);
		for (const locale of locales) {
			if (locale === default_locale) continue;
			const localized = by_namespace_locale.get(`${english.namespace}\u0000${locale}`);
			if (!localized) continue;
			const translated = clean_for_translation(await Bun.file(localized.file).json() as json_obj);
			await save_route_translation_memory(source_path, locale, source, translated, project_dir);
			routes++;
			if (table_name) {
				await save_translation_memory(table_name, locale, source, translated, project_dir);
				tables++;
			}
		}
	}

	// Also snapshot the default-locale source itself into locales-archive/en-us.json
	// - the complete current English inventory in the same per-locale archive
	// format (source == translation). That file is what goes out for external
	// translation: copy it, retarget to the new locale and fill the translation
	// fields, then drop the result back in as locales-archive/{locale}.json and
	// install it (web Import / `bun reeman install-locale`). Inert as memory -
	// default-locale reads are skipped everywhere - and filtered out of the
	// installable-locale listings.
	const default_bundle = await create_translation_bundle(default_locale, project_dir);
	await update_translation_archive(default_locale, (archive) => {
		archive.routes = default_bundle.routes;
		archive.tables = {};
	}, project_dir);

	return { routes, tables };
}

/** Return a generated CRUD table for a namespace, if it owns a sql.ts file. */
export async function table_for_translation_namespace(namespace: string, project_dir: string = process.cwd()): Promise<string | null> {
	try {
		const directory = namespace_directory(namespace, project_dir);
		const sql_file = join(directory, "sql.ts");
		if (!existsSync(sql_file)) return null;
		const content = await Bun.file(sql_file).text();
		return content.match(/export const TABLE_NAME\s*=\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
	} catch { return null; }
}

async function snapshot_directory(route_dir: string, project_dir: string): Promise<void> {
	const table_name = await table_for_route_directory(route_dir);
	const source_file = join(route_dir, `${default_locale}.json`);
	if (existsSync(source_file)) {
		const source = await Bun.file(source_file).json() as json_obj;
		const source_path = relative(project_dir, source_file).split(sep).join("/");
		for (const locale of locales) {
			if (locale === default_locale) continue;
			const translated_file = join(route_dir, `${locale}.json`);
			if (!existsSync(translated_file)) continue;
			const translated = clean_for_translation(await Bun.file(translated_file).json() as json_obj);
			await save_route_translation_memory(source_path, locale, source, translated, project_dir);
			if (table_name) await save_translation_memory(table_name, locale, source, translated, project_dir);
		}
	}
	for (const entry of await readdir(route_dir, { withFileTypes: true })) if (entry.isDirectory()) await snapshot_directory(join(route_dir, entry.name), project_dir);
}

async function table_for_route_directory(route_dir: string): Promise<string | null> {
	const sql_file = join(route_dir, "sql.ts");
	if (!existsSync(sql_file)) return null;
	const content = await Bun.file(sql_file).text();
	return content.match(/export const TABLE_NAME\s*=\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null;
}

/** Save every route and generated-table translation under a folder before removal. */
export async function snapshot_route_translation_memory(route_dir: string, project_dir: string = process.cwd()): Promise<void> {
	try { await snapshot_directory(route_dir, project_dir); }
	catch (error) { console.warn(`⚠ Translation archive snapshot skipped: ${error instanceof Error ? error.message : error}`); }
}
