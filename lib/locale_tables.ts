/**
 * Resolving a logical table to the physical table holding one locale's rows.
 *
 * The runtime counterpart of generator/naming.ts's build-time helpers. Kept
 * separate so generated sql.ts never imports the generator, and duplicated
 * deliberately rather than shared: the generator runs against a config it may
 * be in the middle of rewriting, while this reads the live config once.
 *
 * The base table holds the default locale (D3). There is no clone for the
 * default locale, so a single-locale app resolves every call to the base table
 * and pays nothing.
 */

import { default_locale, locales } from "$config/supported_locales";

function locale_segment(locale_code: string): string {
	const lowercased = locale_code.toLowerCase();
	return lowercased.replaceAll("-", "_");
}

/**
 * The physical table for `locale_code`, or the base table when the locale is
 * the default or is not configured at all. An unconfigured locale falling back
 * to the base table matters: `ctx.locale` is resolved from a header/cookie and
 * must never be able to name a table that does not exist.
 */
export function locale_table(table_name: string, locale_code: string): string {
	if (!locale_code || locale_code === default_locale) return table_name;
	const configured = locales as readonly string[];
	if (!configured.includes(locale_code)) return table_name;
	return `${table_name}_${locale_segment(locale_code)}`;
}

/**
 * Every physical table holding this logical table's rows, base first.
 *
 * The write fan-out and cache invalidation both need this: a write always
 * touches the non-localized columns of every clone, so every locale's cached
 * results go stale, not just the edited locale's.
 */
export function all_locale_tables(table_name: string): string[] {
	const names = [table_name];
	for (const locale_code of locales as readonly string[]) {
		if (locale_code === default_locale) continue;
		names.push(`${table_name}_${locale_segment(locale_code)}`);
	}
	return names;
}

/** Non-default locales, i.e. the ones that have a clone table. */
export function clone_locales(): string[] {
	return (locales as readonly string[]).filter((locale_code) => locale_code !== default_locale);
}

export function is_default_locale(locale_code: string): boolean {
	return !locale_code || locale_code === default_locale;
}
