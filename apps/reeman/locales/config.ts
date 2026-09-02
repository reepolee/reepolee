/**
 * config/supported_locales.ts reader/writer - backs the reeman /locales page.
 *
 * The page is a "fake table" (no DB rows): it reads the current locale
 * configuration and writes it back to config/supported_locales.ts via
 * write_supported_locales(). Locale structure follows the config file's own
 * documented invariants - lowercase BCP 47 codes, default must be in locales,
 * active ⊆ locales, aliases must not chain and never alias the default -
 * which lib/locale.ts re-validates at import time.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalize_locale } from "$lib/locale";

export interface LocalesConfig {
	locales: string[];
	active_locales: string[];
	default_locale: string;
	locale_names: Record<string, string>;
	locale_aliases: Record<string, string>;
}

const CONFIG_PATH = () => join(process.cwd(), "config", "supported_locales.ts");

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function extract_array(content: string, export_name: string): string[] {
	const match = content.match(new RegExp(`export const ${export_name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`));
	if (!match) throw new Error(`Could not parse ${export_name} from config/supported_locales.ts`);
	return match[1]!
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function extract_string(content: string, export_name: string): string {
	const match = content.match(new RegExp(`export const ${export_name}\\s*=\\s*["']([^"']+)["']`));
	if (!match) throw new Error(`Could not parse ${export_name} from config/supported_locales.ts`);
	return match[1]!;
}

function extract_record(content: string, export_name: string): Record<string, string> {
	const match = content.match(new RegExp(`export const ${export_name}\\s*:\\s*Record<string, string>\\s*=\\s*\\{([\\s\\S]*?)\\};`));
	if (!match) return {};
	const record: Record<string, string> = {};
	const entry_pattern = /["']([^"']+)["']\s*:\s*["']([^"']*)["']/g;
	for (const entry of match[1]!.matchAll(entry_pattern)) {
		if (entry[1] !== undefined && entry[2] !== undefined) record[entry[1]] = entry[2];
	}
	return record;
}

export function read_supported_locales(): LocalesConfig {
	const content = readFileSync(CONFIG_PATH(), "utf-8");
	return {
		locales: extract_array(content, "locales"),
		active_locales: extract_array(content, "active_locales"),
		default_locale: extract_string(content, "default_locale"),
		locale_names: extract_record(content, "locale_names"),
		locale_aliases: extract_record(content, "locale_aliases"),
	};
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

function quote_list(items: string[]): string {
	if (items.length === 0) return "[]";
	return `[\n\t${items.map((item) => `"${item}"`).join(",\n\t")},\n]`;
}

function quote_record(record: Record<string, string>): string {
	const entries = Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return "{}";
	return `{\n\t${entries.map(([key, value]) => `"${key}": "${value}",`).join("\n\t")}\n}`;
}

/**
 * Validate a proposed config against the same invariants lib/locale.ts
 * enforces at import time, so a bad write can never crash the next server
 * reload. Throws Error with a human-readable message.
 */
export function validate_supported_locales(cfg: LocalesConfig): void {
	if (cfg.locales.length === 0) throw new Error("At least one locale is required.");
	for (const locale of cfg.locales) {
		try {
			const normalized = normalize_locale(locale);
			if (normalized !== locale) throw new Error(`must be lowercase BCP 47 (e.g. "en-us", not "${normalized}")`);
		} catch {
			throw new Error(`"${locale}" is not a valid BCP 47 locale`);
		}
	}
	const unique = new Set(cfg.locales.map((l) => l.toLowerCase()));
	if (unique.size !== cfg.locales.length) throw new Error("Duplicate locales (comparison is case-insensitive).");
	for (const locale of cfg.active_locales) {
		if (!cfg.locales.includes(locale)) throw new Error(`Active locale "${locale}" is not in locales.`);
	}
	if (!cfg.locales.includes(cfg.default_locale)) throw new Error(`default_locale "${cfg.default_locale}" is not in locales.`);
	if (cfg.locale_aliases[cfg.default_locale]) throw new Error(`default_locale "${cfg.default_locale}" must not be aliased.`);
	for (const [from, to] of Object.entries(cfg.locale_aliases)) {
		if (!cfg.locales.includes(from)) throw new Error(`Alias source "${from}" is not in locales.`);
		if (!cfg.locales.includes(to)) throw new Error(`Alias target "${to}" is not in locales.`);
		if (from === to) throw new Error(`Alias "${from}" points at itself.`);
		if (cfg.locale_aliases[to]) throw new Error(`Alias chain "${from}" -> "${to}" -> "${cfg.locale_aliases[to]}" (targets must be unaliased).`);
	}
}

/**
 * Rewrite config/supported_locales.ts from a structured config. The header
 * comment block (everything up to the first `export const`) is preserved so
 * the file keeps its documentation. Throws on invalid config - nothing is
 * written unless the whole file validates.
 */
export function write_supported_locales(cfg: LocalesConfig): void {
	validate_supported_locales(cfg);

	const content = readFileSync(CONFIG_PATH(), "utf-8");
	const first_export = content.indexOf("export const");
	let header = first_export > 0 ? content.slice(0, first_export) : "";
	// Older writer versions re-appended a "// all locales with translations/content"
	// marker before `export const locales`; on the next write that marker landed
	// inside the preserved header and a fresh copy was appended again, so the
	// comment accumulated on every change (reepolee/reepolee-dev#178). Drop any
	// stale copies from the header and normalize its tail so writes stay idempotent.
	if (header) {
		header = header
			.split("\n")
			.filter((line) => line.trim() !== "// all locales with translations/content")
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/\s+$/, "\n\n");
	}

	const next = [
		header,
		`export const locales = ${quote_list(cfg.locales)} as const;`,
		"",
		"// locale chooser from this list",
		`export const active_locales = ${quote_list(cfg.active_locales)} as const;`,
		"",
		"// first served without selection; its content lives in the source columns",
		`export const default_locale = "${cfg.default_locale}";`,
		"",
		`export const locale_names: Record<string, string> = ${quote_record(cfg.locale_names)};`,
		"",
		"// UI-string serving aliases: requests for the key locale render the value",
		"// locale's translations (e.g. { \"de-at\": \"de-de\" }). One level only; targets",
		"// must not themselves be aliased. Content values are never aliased - they are",
		"// copied per locale in the CRUD editor.",
		`export const locale_aliases: Record<string, string> = ${quote_record(cfg.locale_aliases)};`,
		"",
	].join("\n");

	writeFileSync(CONFIG_PATH(), next, "utf-8");
}
export const navigation = {
	section_key: "reeman.nav.system",
	item_order: 20,
	section_order: 30,
	group_order: null,
	final_order: null,
};
