/**
 * Copying values between locales.
 *
 * Locales never share content live - reuse is an explicit one-time copy
 * ("use the German text for Austria"). Each copied field records where it came
 * from plus a hash of the source value AT COPY TIME, in the `<field>_src` and
 * `<field>_hash` sidecar columns on the locale's own row, so the editor can
 * later be told "the original changed since you copied this" instead of
 * silently drifting.
 *
 * Editing a copied value by hand clears its provenance - it is then just a
 * value, and no longer tracked.
 */

import { db } from "$config/db";
import { default_locale, locale_names } from "$config/supported_locales";
import { hash_localized_value, serialize_for_hash } from "$lib/localized_hash";
import { locale_table } from "$lib/locale_tables";
import { translate_json } from "$generator/translator";

// Re-exported so callers of the copy API get the hashing helpers alongside it.
export { hash_localized_value, serialize_for_hash };

export interface StaleCopyNotice {
	field_name: string;
	locale_code: string;
	copied_from_locale: string;
}

export function source_column(field_name: string): string { return `${field_name}_src`; }
export function hash_column(field_name: string): string { return `${field_name}_hash`; }

function quote(identifier: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
	return `"${identifier}"`;
}

/** One locale's row for a record, or undefined when that locale has none. */
export async function get_locale_row(table_name: string, record_id: number, locale_code: string): Promise<Record<string, any> | undefined> {
	const table = locale_table(table_name, locale_code);
	const rows = (await db.unsafe(`SELECT * FROM ${quote(table)} WHERE ${quote("id")} = ? LIMIT 1`, [record_id])) as any[];
	return rows[0];
}

/** Every non-default locale's row for a record, keyed by locale code. */
export async function get_locale_rows(table_name: string, record_id: number, locale_codes: readonly string[]): Promise<Record<string, Record<string, any>>> {
	const wanted = locale_codes.filter((locale_code) => locale_code !== default_locale);
	const lookups = wanted.map((locale_code) => get_locale_row(table_name, record_id, locale_code));
	const rows = await Promise.all(lookups);

	const by_locale: Record<string, Record<string, any>> = {};
	for (let index = 0; index < wanted.length; index++) {
		const row = rows[index];
		if (row) by_locale[wanted[index]!] = row;
	}
	return by_locale;
}

/**
 * Copy one locale's values into another, stamping provenance.
 *
 * Copying INTO the default locale is rejected: the base table is the source of
 * truth every other locale is derived from (D3), so writing a translation back
 * over it would invert the model.
 */
export async function copy_localized_values(
	table_name: string,
	record_id: number,
	field_names: readonly string[],
	from_locale: string,
	to_locale: string,
): Promise<number> {
	if (from_locale === to_locale) throw new Error(`Cannot copy locale onto itself: ${to_locale}`);
	if (to_locale === default_locale) throw new Error(`Cannot copy into the default locale (${default_locale}) - it is the source every other locale derives from`);

	const source_row = await get_locale_row(table_name, record_id, from_locale);
	if (!source_row) return 0;

	const target_table = locale_table(table_name, to_locale);
	const assignments: string[] = [];
	const params: unknown[] = [];
	let copied = 0;

	for (const field_name of field_names) {
		const value = source_row[field_name];
		if (value === null || value === undefined) continue;

		assignments.push(`${quote(field_name)} = ?`, `${quote(source_column(field_name))} = ?`, `${quote(hash_column(field_name))} = ?`);
		params.push(value, from_locale, hash_localized_value(value));
		copied++;
	}

	if (copied === 0) return 0;

	await db.unsafe(`UPDATE ${quote(target_table)} SET ${assignments.join(", ")} WHERE ${quote("id")} = ?`, [...params, record_id]);
	return copied;
}

/**
 * AI-generate a first-draft translation of every field into `to_locale`,
 * sourced from whatever `from_locale` currently holds.
 *
 * Provenance is stamped exactly like a manual copy - source locale plus a hash
 * of the UNTRANSLATED source value - so the stale-copy notice fires for free
 * if the source is edited afterward, with no separate "generated" tracking. A
 * generated value is just a copy whose text passed through a translator on the
 * way in; it is fully editable afterward like any other.
 */
export async function generate_localized_values(
	table_name: string,
	record_id: number,
	field_names: readonly string[],
	from_locale: string,
	to_locale: string,
): Promise<number> {
	if (from_locale === to_locale) throw new Error(`Cannot generate locale from itself: ${to_locale}`);
	if (to_locale === default_locale) throw new Error(`Cannot generate into the default locale (${default_locale}) - it is the source every other locale derives from`);

	const source_row = await get_locale_row(table_name, record_id, from_locale);
	if (!source_row) return 0;

	const to_translate: Record<string, string> = {};
	for (const field_name of field_names) {
		const value = source_row[field_name];
		if (typeof value === "string" && value.trim() !== "") to_translate[field_name] = value;
	}

	const target_lang = locale_names[to_locale] || to_locale;
	const source_lang = locale_names[from_locale] || from_locale;
	const translated: Record<string, string> = Object.keys(to_translate).length > 0
		? await translate_json(to_translate, target_lang, { source_lang })
		: {};

	const target_table = locale_table(table_name, to_locale);
	const assignments: string[] = [];
	const params: unknown[] = [];
	let generated = 0;

	for (const field_name of field_names) {
		const source_value = source_row[field_name];
		if (source_value === null || source_value === undefined) continue;

		// Only text goes through translation; numbers, flags and dates are
		// carried over verbatim - "translating" them means nothing.
		const value = typeof translated[field_name] === "string" ? translated[field_name] : source_value;

		assignments.push(`${quote(field_name)} = ?`, `${quote(source_column(field_name))} = ?`, `${quote(hash_column(field_name))} = ?`);
		params.push(value, from_locale, hash_localized_value(source_value));
		generated++;
	}

	if (generated === 0) return 0;

	await db.unsafe(`UPDATE ${quote(target_table)} SET ${assignments.join(", ")} WHERE ${quote("id")} = ?`, [...params, record_id]);
	return generated;
}

/**
 * Copied values whose source has changed since the copy was made. Drives the
 * "the original changed" notice on the affected panels.
 */
export function stale_copy_notices(
	record: Record<string, any>,
	locale_rows: Record<string, Record<string, any>>,
	field_names: readonly string[],
): StaleCopyNotice[] {
	const notices: StaleCopyNotice[] = [];

	for (const [locale_code, row] of Object.entries(locale_rows)) {
		for (const field_name of field_names) {
			const copied_from = row[source_column(field_name)];
			const copied_hash = row[hash_column(field_name)];
			if (!copied_from || !copied_hash) continue;

			const source_row = copied_from === default_locale ? record : locale_rows[copied_from];
			if (!source_row) continue;

			const current_hash = hash_localized_value(source_row[field_name]);
			if (current_hash === copied_hash) continue;

			notices.push({ field_name, locale_code, copied_from_locale: copied_from });
		}
	}

	return notices;
}

/** Notices keyed like form state, for O(1) lookup while rendering panels. */
export function stale_copy_map(notices: readonly StaleCopyNotice[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const notice of notices) {
		map[`${notice.field_name}|${notice.locale_code}`] = notice.copied_from_locale;
	}
	return map;
}

/**
 * Clear provenance for fields the user edited by hand: an edited value is no
 * longer a copy, so the stale notice must stop firing for it.
 */
export function clear_provenance_assignments(field_names: readonly string[]): { assignments: string[]; } {
	const assignments: string[] = [];
	for (const field_name of field_names) {
		assignments.push(`${quote(source_column(field_name))} = NULL`, `${quote(hash_column(field_name))} = NULL`);
	}
	return { assignments };
}
