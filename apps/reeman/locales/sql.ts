/**
 * Config-backed "sql" layer for the locales fake table - mirrors the db_tables
 * sql.ts interface (search_records, get_record_by_id, get_all_records,
 * update_record) but reads/writes config/supported_locales.ts instead of a DB
 * table. The locale code is the row identity (route_param = "code").
 */

import { normalize_locale } from "$lib/locale";
import type { ResolvedFilter } from "$lib/table_filters";

import { read_supported_locales, validate_supported_locales, write_supported_locales, type LocalesConfig } from "./config";

export interface LocaleRecord {
	code: string;
	name: string;
	alias: string;
	/** 1 when the locale is in active_locales. */
	active: number;
	/** 1 when the locale is the default_locale. */
	is_default: number;
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function cfg_to_records(cfg: LocalesConfig): LocaleRecord[] {
	return cfg.locales.map((code) => ({
		code,
		name: cfg.locale_names[code] || "",
		alias: cfg.locale_aliases[code] || "",
		active: cfg.active_locales.includes(code) ? 1 : 0,
		is_default: cfg.default_locale === code ? 1 : 0,
	}));
}

// ---------------------------------------------------------------------------
// Queries (mirror db_tables/sql.ts surface)
// ---------------------------------------------------------------------------

export async function get_all_records(): Promise<LocaleRecord[]> {
	return cfg_to_records(read_supported_locales());
}

export async function get_locales_select_options(): Promise<Options[]> {
	const cfg = read_supported_locales();
	return cfg.locales.map((code) => ({
		option_value: code,
		option_text: cfg.locale_names[code] || code,
	}));
}

/** Locales already in `locales` (translations exist) but not yet in `active_locales` - offered as the multiselect on the Add Locale dialog. */
export async function get_inactive_supported_locales(): Promise<Options[]> {
	const cfg = read_supported_locales();
	return cfg.locales
		.filter((code) => !cfg.active_locales.includes(code))
		.map((code) => ({
			option_value: code,
			option_text: cfg.locale_names[code] || code,
		}));
}

export async function get_record_by_id(code: string): Promise<LocaleRecord | undefined> {
	const normalized = code.trim().toLowerCase();
	return get_all_records().then((records) => records.find((r) => r.code === normalized));
}

export async function search_records(
	search: string = "",
	offset: number = 0,
	limit: number = 20,
	order_by: string = "code::asc",
	_scope_clause: string = "",
	filter_clauses: ResolvedFilter[] = [],
): Promise<{ records: LocaleRecord[]; total: number; }> {
	let records = cfg_to_records(read_supported_locales());

	// Search across code/name/alias (case-insensitive)
	if (search) {
		const term = search.toLowerCase();
		records = records.filter((r) =>
			r.code.toLowerCase().includes(term)
			|| r.name.toLowerCase().includes(term)
			|| r.alias.toLowerCase().includes(term)
		);
	}

	// Apply resolved filter clauses (mirrors db_tables: the clause column
	// maps to a LocaleRecord field, `?` placeholders are filled from params).
	for (const filter of filter_clauses) {
		records = records.filter((r) => {
			const value = String((r as unknown as globalThis.Record<string, unknown>)[filter.column] ?? "");
			const param = String(filter.params[0] ?? "");
			const clause = filter.clause.trim();

			if (clause === `${filter.column} != ?`) return value !== param;
			if (clause === `${filter.column} = ?`) return value === param;
			if (clause === `${filter.column} LIKE ?`) return value.includes(param);
			if (clause === `${filter.column} NOT LIKE ?`) return !value.includes(param);
			// Unknown clause shape - ignore defensively
			return true;
		});
	}

	// Sort by a validated field
	const parts = order_by.split("::");
	const sort_field = parts[0] || "code";
	const sort_direction = parts[1]?.toLowerCase() === "desc" ? -1 : 1;
	const valid_fields = ["code", "name", "alias", "active", "default", "is_default"] as const;

	const field = (valid_fields as readonly string[]).includes(sort_field) ? sort_field : "code";
	records = [...records].sort((a, b) => {
		const av = (a as unknown as globalThis.Record<string, unknown>)[field];
		const bv = (b as unknown as globalThis.Record<string, unknown>)[field];
		return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true }) * sort_direction;
	});

	const total = records.length;
	const paged = offset > 0 || limit < total ? records.slice(offset, offset + limit) : records;

	return { records: paged, total };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Update a single locale's display fields (name / alias / active / default) in
 * the config file. Locale codes themselves are immutable - use add/remove
 * generator actions to change the locale set.
 */
export async function update_record(code: string, patch: Partial<Pick<LocaleRecord, "name" | "alias" | "active" | "is_default">>): Promise<LocaleRecord | undefined> {
	const cfg = read_supported_locales();
	if (!cfg.locales.includes(code)) return undefined;

	if (patch.name !== undefined) {
		if (patch.name.trim()) cfg.locale_names[code] = patch.name.trim();
		else delete cfg.locale_names[code];
	}
	if (patch.alias !== undefined) {
		if (patch.alias.trim()) cfg.locale_aliases[code] = normalize_locale(patch.alias.trim());
		else delete cfg.locale_aliases[code];
	}
	if (patch.active !== undefined) {
		cfg.active_locales = patch.active === 1
			? [...new Set([...cfg.active_locales, code])]
			: cfg.active_locales.filter((l) => l !== code);
	}
	if (patch.is_default !== undefined && patch.is_default === 1) {
		cfg.default_locale = code;
	}

	validate_supported_locales(cfg);
	write_supported_locales(cfg);

	return cfg_to_records(cfg).find((r) => r.code === code);
}

/** Remove a locale from the config (codes only - translations/tables handled by the generator action). */
export async function delete_record(code: string): Promise<boolean> {
	const cfg = read_supported_locales();
	if (!cfg.locales.includes(code)) return false;
	if (cfg.locales.length <= 1) return false;

	const next: LocalesConfig = {
		...cfg,
		locales: cfg.locales.filter((l) => l !== code),
		active_locales: cfg.active_locales.filter((l) => l !== code),
		locale_names: Object.fromEntries(Object.entries(cfg.locale_names).filter(([k]) => k !== code)),
		locale_aliases: Object.fromEntries(Object.entries(cfg.locale_aliases).filter(([k]) => k !== code)),
	};
	if (cfg.default_locale === code) next.default_locale = next.locales[0]!;

	validate_supported_locales(next);
	write_supported_locales(next);
	return true;
}
