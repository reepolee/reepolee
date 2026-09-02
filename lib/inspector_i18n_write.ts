/**
 * Dev-only translation read/write for the inspector. Translation keys are
 * resolved against the source template's namespace file, then the root file.
 */

import { existsSync } from "node:fs";
import { translations } from "$lib/i18n";
import { notify_clients } from "$lib/livereload";
import {
	get_dotted,
	serialize_translation_write,
	set_dotted,
	translation_file,
} from "$lib/translation_files";
import type { json_obj } from "$lib/translation_merge";

/** Candidate locale files for a namespace, most specific first. */
export function candidate_files(project_dir: string, namespace_hint: string | null, locale: string): string[] {
	const files: string[] = [];
	const normalized_namespace = namespace_hint?.replaceAll("/", ".") || "root";
	if (normalized_namespace !== "root") {
		try {
			files.push(translation_file(normalized_namespace, locale, project_dir));
		} catch {
			// Invalid source namespaces fall through to the root file.
		}
	}
	files.push(translation_file("root", locale, project_dir));
	return [...new Set(files)];
}

function detect_indent(raw_text: string): string {
	const match = raw_text.match(/\n([\t ]+)\S/);
	if (!match) return "\t";
	const indent = match[1] as string;
	return indent[0] === "\t" ? "\t" : indent;
}

export type I18nResolveResult = { ok: true; file: string; current: string | undefined; } | { ok: false; reason: string; };

export async function resolve_i18n_target(project_dir: string, namespace_hint: string | null, locale: string, key_path: string): Promise<I18nResolveResult> {
	if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(key_path)) {
		return { ok: false, reason: `invalid key: ${key_path}` };
	}

	const candidates = candidate_files(project_dir, namespace_hint, locale);
	let first_existing: string | null = null;
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		if (first_existing === null) first_existing = file;
		const obj = await Bun.file(file).json() as json_obj;
		const current = get_dotted(obj, key_path);
		if (current !== undefined) {
			return { ok: true, file, current: typeof current === "string" ? current : String(current) };
		}
	}

	if (first_existing === null) return { ok: false, reason: `no ${locale}.json for this page` };
	return { ok: true, file: first_existing, current: undefined };
}

export type I18nGetResult = { ok: true; value: string; } | { ok: false; reason: string; };

export async function get_i18n_value(locale: string, dotted_path: string, _url: string, namespace_hint: string | null = null): Promise<I18nGetResult> {
	const resolved = await resolve_i18n_target(process.cwd(), namespace_hint, locale, dotted_path);
	if (!resolved.ok) return resolved;
	if (resolved.current === undefined) return { ok: false, reason: `no translation found for "${dotted_path}" (${locale})` };
	return { ok: true, value: resolved.current };
}

export type I18nUpdateResult = { ok: true; } | { ok: false; reason: string; };

export async function update_i18n_value(locale: string, dotted_path: string, value: string, _url: string, namespace_hint: string | null = null): Promise<I18nUpdateResult> {
	const resolved = await resolve_i18n_target(process.cwd(), namespace_hint, locale, dotted_path);
	if (!resolved.ok) return resolved;

	await serialize_translation_write(async () => {
		const existing_text = await Bun.file(resolved.file).text();
		const obj = JSON.parse(existing_text) as json_obj;
		set_dotted(obj, dotted_path, value);
		const indent = detect_indent(existing_text);
		const serialized = JSON.stringify(obj, null, indent) + "\n";
		await Bun.write(resolved.file, serialized);
	});

	await translations.reload();
	notify_clients();
	return { ok: true };
}
