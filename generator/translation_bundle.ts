import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { MAIN_APP, PLATFORM_DIR, REEMAN_APP, REEQA_APP } from "$config/paths";
import { normalize_locale } from "$lib/locale";
import { list_translation_files } from "$lib/translation_files";
import { apply_translations, is_object, sort_object, sync_lang_to_en, type json_obj } from "$lib/translation_merge";

export const TRANSLATION_BUNDLE_FORMAT = "reepolee-translations-v1";
export const TRANSLATION_ARCHIVE_DIR = "locales-archive";

export interface TranslationBundleFile {
	source_hash: string;
	translations: json_obj;
}

export interface TranslationBundle {
	format: typeof TRANSLATION_BUNDLE_FORMAT;
	source_locale: "en-us";
	target_locale: string | null;
	files: Record<string, TranslationBundleFile>;
}

export interface ArchivedTranslationBundle {
	code: string;
	file_count: number;
	is_current: boolean;
}

function posix_relative(project_dir: string, file: string): string {
	return relative(project_dir, file).split(sep).join("/");
}

function source_hash(translations: json_obj): string {
	const canonical = JSON.stringify(sort_object(translations));
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(canonical);
	return hasher.digest("hex");
}

async function english_source_files(project_dir: string): Promise<Array<{ path: string; translations: json_obj; source_hash: string; }>> {
	const listed_files = await list_translation_files(project_dir);
	const english_files = listed_files.filter((item) => item.locale === "en-us");
	english_files.sort((left, right) => left.file.localeCompare(right.file));
	const sources: Array<{ path: string; translations: json_obj; source_hash: string; }> = [];
	for (const item of english_files) {
		const translations = await Bun.file(item.file).json() as json_obj;
		sources.push({
			path: posix_relative(project_dir, item.file),
			translations: sort_object(translations),
			source_hash: source_hash(translations),
		});
	}
	return sources;
}

export async function create_translation_bundle(target_locale: string | null = null, project_dir: string = process.cwd()): Promise<TranslationBundle> {
	const normalized_target = target_locale === null ? null : normalize_locale(target_locale);
	const sources = await english_source_files(project_dir);
	const files: Record<string, TranslationBundleFile> = {};
	for (const source of sources) {
		files[source.path] = {
			source_hash: source.source_hash,
			translations: source.translations,
		};
	}
	return {
		format: TRANSLATION_BUNDLE_FORMAT,
		source_locale: "en-us",
		target_locale: normalized_target,
		files,
	};
}

async function write_json_atomic(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temp_file = `${file}.tmp-${crypto.randomUUID()}`;
	const backup_file = `${file}.bak-${crypto.randomUUID()}`;
	const had_original = existsSync(file);
	await Bun.write(temp_file, `${JSON.stringify(value, null, "\t")}\n`);
	try {
		if (had_original) await rename(file, backup_file);
		await rename(temp_file, file);
		if (had_original) await rm(backup_file, { force: true });
	} catch (error) {
		await rm(temp_file, { force: true });
		if (had_original && existsSync(backup_file)) await rename(backup_file, file);
		throw error;
	}
}

export async function export_translation_bundle(output_file: string, target_locale: string | null = null, project_dir: string = process.cwd()): Promise<TranslationBundle> {
	const bundle = await create_translation_bundle(target_locale, project_dir);
	const absolute_output = isAbsolute(output_file) ? output_file : resolve(project_dir, output_file);
	await write_json_atomic(absolute_output, bundle);
	return bundle;
}

function assert_plain_translation_object(value: unknown, label: string): asserts value is json_obj {
	if (!is_object(value)) throw new Error(`${label} must be a JSON object.`);
	for (const [key, child] of Object.entries(value)) {
		if (is_object(child)) {
			assert_plain_translation_object(child, `${label}.${key}`);
		} else if (typeof child !== "string") {
			throw new Error(`${label}.${key} must be a string leaf.`);
		}
	}
}

function collect_placeholders(value: string): string[] {
	const matches = value.match(/\{[a-zA-Z_][a-zA-Z0-9_.]*\}/g) ?? [];
	return matches.sort();
}

function validate_translation_tree(source: json_obj, translated: json_obj, label: string): void {
	for (const key of Object.keys(translated).sort()) {
		if (!(key in source)) throw new Error(`${label}.${key} does not exist in the current English source.`);
		const source_value = source[key];
		const translated_value = translated[key];
		if (is_object(source_value)) {
			if (!is_object(translated_value)) throw new Error(`${label}.${key} must remain an object.`);
			validate_translation_tree(source_value, translated_value, `${label}.${key}`);
			continue;
		}
		if (typeof source_value !== "string" || typeof translated_value !== "string") {
			throw new Error(`${label}.${key} must remain a string leaf.`);
		}
		const source_placeholders = collect_placeholders(source_value);
		const translated_placeholders = collect_placeholders(translated_value);
		if (JSON.stringify(source_placeholders) !== JSON.stringify(translated_placeholders)) {
			throw new Error(`${label}.${key} does not preserve placeholders.`);
		}
	}
}

function normalize_bundle_path(path: string, target_locale: string): string {
	if (path.endsWith("/en-us.json")) return path;
	const target_suffix = `/${target_locale}.json`;
	if (path.endsWith(target_suffix)) return `${path.slice(0, -target_suffix.length)}/en-us.json`;
	return path;
}

export interface ParseTranslationBundleOptions {
	/**
	 * Lenient mode is used by the install/import path. Import must never fail
	 * on stale translations (issue #418): entries whose source path no longer
	 * exists (deleted/renamed route) are skipped instead of rejecting the
	 * whole bundle, and translated leaves are copied as-is without comparing
	 * them against the current en-us tree - missing or outdated keys fall back
	 * to en-us at render time and are the user's to fix. Structural integrity
	 * (shape, string leaves, hash format) is still enforced so install never
	 * writes a corrupt file. Strict mode (default) keeps full validation for
	 * freshly uploaded bundles.
	 */
	lenient?: boolean;
}

export async function parse_and_validate_translation_bundle(input: unknown, project_dir: string = process.cwd(), options: ParseTranslationBundleOptions = {}): Promise<TranslationBundle> {
	const lenient = options.lenient ?? false;
	if (!is_object(input)) throw new Error("Translation bundle must be a JSON object.");
	if (input.format !== TRANSLATION_BUNDLE_FORMAT) throw new Error(`Unsupported translation bundle format: ${String(input.format)}`);
	if (input.source_locale !== "en-us") throw new Error("Translation bundle source_locale must be en-us.");
	if (typeof input.target_locale !== "string") throw new Error("Translated bundle target_locale must be set.");
	const target_locale = normalize_locale(input.target_locale);
	if (target_locale === "en-us") throw new Error("Translated bundle target_locale cannot be en-us.");
	assert_plain_translation_object(input.files, "files");

	const sources = await english_source_files(project_dir);
	const sources_by_path = new Map(sources.map((source) => [source.path, source]));
	const normalized_entries = new Map<string, unknown>();
	for (const [raw_path, raw_file] of Object.entries(input.files)) {
		const normalized_path = normalize_bundle_path(raw_path, target_locale);
		if (!sources_by_path.has(normalized_path)) {
			// Stale entry: no current English source to mirror into a live
			// folder (its route was deleted or renamed). Strict mode rejects
			// the bundle; lenient import just skips it and installs the rest.
			if (!lenient) {
				throw new Error(`Archived entry "${raw_path}" is stale because no current English source exists at "${normalized_path}". Refresh locales-archive/${target_locale}.json from the current en-us files, or remove this entry if its route was deleted.`);
			}
			continue;
		}
		if (normalized_entries.has(normalized_path)) throw new Error(`Translation bundle contains duplicate source paths: ${normalized_path}`);
		normalized_entries.set(normalized_path, raw_file);
	}
	if (normalized_entries.size === 0) throw new Error("Translation bundle must contain at least one file.");

	const files: Record<string, TranslationBundleFile> = {};
	for (const [source_path, raw_file] of normalized_entries) {
		const source = sources_by_path.get(source_path)!;
		if (!is_object(raw_file)) throw new Error(`Bundle entry must be an object: ${source.path}`);
		const entry_keys = Object.keys(raw_file).sort();
		if (JSON.stringify(entry_keys) !== JSON.stringify(["source_hash", "translations"])) {
			throw new Error(`Bundle entry has unsupported fields: ${source.path}`);
		}
		if (typeof raw_file.source_hash !== "string" || !/^[a-f0-9]{64}$/i.test(raw_file.source_hash)) {
			throw new Error(`Bundle entry has an invalid source_hash: ${source.path}`);
		}
		assert_plain_translation_object(raw_file.translations, `files.${source.path}.translations`);
		// Lenient import copies the archived leaves as-is: keys that no longer
		// exist in en-us or placeholders that drifted are kept and rendered
		// with en-us fallback, never blocking the import.
		if (!lenient) validate_translation_tree(source.translations, raw_file.translations, `files.${source.path}.translations`);
		files[source.path] = {
			source_hash: source.source_hash,
			translations: sort_object(raw_file.translations),
		};
	}

	return {
		format: TRANSLATION_BUNDLE_FORMAT,
		source_locale: "en-us",
		target_locale,
		files,
	};
}

export async function read_translation_bundle(bundle_file: string, project_dir: string = process.cwd(), options: ParseTranslationBundleOptions = {}): Promise<TranslationBundle> {
	const absolute_file = isAbsolute(bundle_file) ? bundle_file : resolve(project_dir, bundle_file);
	if (!existsSync(absolute_file)) throw new Error(`Translation bundle not found: ${bundle_file}`);
	const input = await Bun.file(absolute_file).json();
	return await parse_and_validate_translation_bundle(input, project_dir, options);
}

export function archive_bundle_file(locale: string, project_dir: string = process.cwd()): string {
	const normalized_locale = normalize_locale(locale);
	return join(project_dir, TRANSLATION_ARCHIVE_DIR, `${normalized_locale}.json`);
}

export async function archive_translation_bundle(bundle_file: string, project_dir: string = process.cwd()): Promise<TranslationBundle> {
	const bundle = await read_translation_bundle(bundle_file, project_dir);
	return await archive_validated_translation_bundle(bundle, project_dir);
}

async function archive_validated_translation_bundle(bundle: TranslationBundle, project_dir: string): Promise<TranslationBundle> {
	const target_file = archive_bundle_file(bundle.target_locale!, project_dir);
	const merged = await create_translation_bundle(bundle.target_locale, project_dir);
	if (existsSync(target_file)) {
		// Read the existing archive leniently so a stale entry (a route deleted
		// since the archive was written) does not block re-archiving: stale
		// paths are dropped from the merge rather than failing the upload.
		const existing = await read_translation_bundle(target_file, project_dir, { lenient: true });
		for (const [path, file] of Object.entries(existing.files)) {
			merged.files[path]!.translations = apply_translations(merged.files[path]!.translations, file.translations);
		}
	}
	for (const [path, file] of Object.entries(bundle.files)) {
		merged.files[path]!.translations = apply_translations(merged.files[path]!.translations, file.translations);
	}
	for (const file of Object.values(merged.files)) file.translations = sort_object(file.translations);
	await write_json_atomic(target_file, merged);
	return merged;
}

export async function archive_translation_bundle_data(input: unknown, project_dir: string = process.cwd()): Promise<TranslationBundle> {
	const bundle = await parse_and_validate_translation_bundle(input, project_dir);
	return await archive_validated_translation_bundle(bundle, project_dir);
}

export async function list_archived_translation_bundles(project_dir: string = process.cwd()): Promise<ArchivedTranslationBundle[]> {
	const archive_dir = join(project_dir, TRANSLATION_ARCHIVE_DIR);
	if (!existsSync(archive_dir)) return [];
	const entries = await readdir(archive_dir, { withFileTypes: true });
	const sources = await english_source_files(project_dir);
	const current_hashes = new Map(sources.map((source) => [source.path, source.source_hash]));
	const bundles: ArchivedTranslationBundle[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !/^[a-z]{2,3}-[a-z0-9]{2,8}\.json$/.test(entry.name)) continue;
		try {
			const bundle = await Bun.file(join(archive_dir, entry.name)).json() as TranslationBundle;
			if (bundle.format !== TRANSLATION_BUNDLE_FORMAT || typeof bundle.target_locale !== "string" || !is_object(bundle.files)) continue;
			if (`${bundle.target_locale}.json` !== entry.name) continue;
			const paths = Object.keys(bundle.files);
			const is_current = paths.length === current_hashes.size && paths.every((path) => bundle.files[path]?.source_hash === current_hashes.get(path));
			bundles.push({ code: bundle.target_locale, file_count: paths.length, is_current });
		} catch {
			continue;
		}
	}
	bundles.sort((left, right) => left.code.localeCompare(right.code));
	return bundles;
}

async function write_live_bundle(bundle: TranslationBundle, project_dir: string): Promise<void> {
	const target_locale = bundle.target_locale!;
	const pending: Array<{ target: string; temp: string; backup: string; had_original: boolean; }> = [];
	for (const [source_path, file] of Object.entries(bundle.files)) {
		const target_relative = source_path.replace(/en-us\.json$/, `${target_locale}.json`);
		const target = resolve(project_dir, ...target_relative.split("/"));
		const expected_root = resolve(project_dir);
		if (!target.startsWith(`${expected_root}${sep}`)) throw new Error(`Unsafe translation path: ${source_path}`);
		await mkdir(dirname(target), { recursive: true });
		const temp = `${target}.tmp-${crypto.randomUUID()}`;
		const backup = `${target}.bak-${crypto.randomUUID()}`;
		const serialized = `${JSON.stringify(sort_object(file.translations), null, "\t")}\n`;
		await Bun.write(temp, serialized);
		pending.push({ target, temp, backup, had_original: existsSync(target) });
	}

	const committed: typeof pending = [];
	try {
		for (const item of pending) {
			if (item.had_original) await rename(item.target, item.backup);
			await rename(item.temp, item.target);
			committed.push(item);
		}
		for (const item of committed) await rm(item.backup, { force: true });
	} catch (error) {
		for (const item of committed.reverse()) {
			await rm(item.target, { force: true });
			if (item.had_original && existsSync(item.backup)) await rename(item.backup, item.target);
		}
		for (const item of pending) {
			await rm(item.temp, { force: true });
			if (item.had_original && existsSync(item.backup) && !existsSync(item.target)) await rename(item.backup, item.target);
		}
		throw error;
	}
}

export async function install_archived_translation_bundle(locale: string, project_dir: string = process.cwd()): Promise<TranslationBundle> {
	const bundle_file = archive_bundle_file(locale, project_dir);
	// Lenient read: importing a locale must never fail on stale translations
	// (issue #418) - stale paths are skipped and leaves are copied as-is.
	const bundle = await read_translation_bundle(bundle_file, project_dir, { lenient: true });
	await write_live_bundle(bundle, project_dir);
	return bundle;
}

function legacy_archive_file(source_path: string, locale: string, project_dir: string): string {
	let legacy_path: string;
	if (source_path.startsWith(`${MAIN_APP.split(sep).join("/")}/system/auth/`)) {
		legacy_path = `routes/system/auth/${source_path.slice(`${MAIN_APP.split(sep).join("/")}/system/auth/`.length)}`;
	} else if (source_path.startsWith(`${PLATFORM_DIR}/`)) {
		legacy_path = `routes/system/${source_path.slice(`${PLATFORM_DIR}/`.length)}`;
	} else if (source_path.startsWith(`${MAIN_APP.split(sep).join("/")}/`)) {
		legacy_path = `routes/${source_path.slice(`${MAIN_APP.split(sep).join("/")}/`.length)}`;
	} else if (source_path.startsWith(`${REEMAN_APP.split(sep).join("/")}/`)) {
		legacy_path = `routes_reeman/${source_path.slice(`${REEMAN_APP.split(sep).join("/")}/`.length)}`;
	} else if (source_path.startsWith(`${REEQA_APP.split(sep).join("/")}/`)) {
		legacy_path = `routes_reeqa/${source_path.slice(`${REEQA_APP.split(sep).join("/")}/`.length)}`;
	} else {
		legacy_path = source_path;
	}
	return join(project_dir, TRANSLATION_ARCHIVE_DIR, ...legacy_path.replace(/en-us\.json$/, `${locale}.json`).split("/"));
}

export async function migrate_legacy_translation_archive(project_dir: string = process.cwd()): Promise<string[]> {
	const archive_dir = join(project_dir, TRANSLATION_ARCHIVE_DIR);
	const legacy_roots = ["locales", "routes", "routes_reeman", "routes_reeqa"];
	const locale_codes = new Set<string>();
	async function collect_locales(directory: string): Promise<void> {
		if (!existsSync(directory)) return;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const full_path = join(directory, entry.name);
			if (entry.isDirectory()) await collect_locales(full_path);
			else {
				const match = /^([a-z]{2,3}-[a-z0-9]{2,8})\.json$/.exec(entry.name);
				if (match) locale_codes.add(match[1]!);
			}
		}
	}
	for (const legacy_root of legacy_roots) await collect_locales(join(archive_dir, legacy_root));

	const sources = await english_source_files(project_dir);
	const written: string[] = [];
	for (const locale of [...locale_codes].sort()) {
		const files: Record<string, TranslationBundleFile> = {};
		for (const source of sources) {
			const legacy_file = legacy_archive_file(source.path, locale, project_dir);
			const legacy_translations = existsSync(legacy_file) ? await Bun.file(legacy_file).json() as json_obj : {};
			const translations = sync_lang_to_en(source.translations, legacy_translations, true);
			files[source.path] = { source_hash: source.source_hash, translations: sort_object(translations) };
		}
		const bundle: TranslationBundle = {
			format: TRANSLATION_BUNDLE_FORMAT,
			source_locale: "en-us",
			target_locale: locale,
			files,
		};
		const output_file = archive_bundle_file(locale, project_dir);
		await write_json_atomic(output_file, bundle);
		written.push(output_file);
	}

	for (const legacy_root of legacy_roots) {
		const target = resolve(archive_dir, legacy_root);
		const expected_parent = resolve(archive_dir);
		if (dirname(target) !== expected_parent) throw new Error(`Unsafe legacy archive path: ${target}`);
		await rm(target, { recursive: true, force: true });
	}
	return written;
}
