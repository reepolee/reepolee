/**
 * Formatting utilities - extracted from lib/helpers.ts
 *
 * Functions for formatting numbers, currency, percentages, pluralization,
 * and bulk delete messages.
 *
 * Intl formatter construction costs tens of microseconds per instance, which
 * dominates index pages that format hundreds of cells - all formatters are
 * memoized per (locale, options) here.
 */

const _number_formats = new Map<string, Intl.NumberFormat>();

function cached_number_format(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
	const key = `${locale}|${options ? JSON.stringify(options) : ""}`;
	let nf = _number_formats.get(key);
	if (!nf) {
		nf = new Intl.NumberFormat(locale, options);
		_number_formats.set(key, nf);
	}
	return nf;
}

const _plural_rules = new Map<string, Intl.PluralRules>();

function cached_plural_rules(locale: string): Intl.PluralRules {
	let pr = _plural_rules.get(locale);
	if (!pr) {
		pr = new Intl.PluralRules(locale);
		_plural_rules.set(locale, pr);
	}
	return pr;
}

/**
 * Format a number as EUR currency with locale-aware formatting.
 * Uses currencyDisplay "code" so we can reliably replace "EUR" with the desired symbol.
 */
export function display_currency(val: number, locale: string = "sl-SI", hide_zero = false, symbol = "€"): string {
	if (val === undefined) val = 0;

	if (hide_zero && val === 0) return "";
	const ret = cached_number_format(locale, {
		style: "currency",
		currency: "EUR",
		currencyDisplay: "code",
		useGrouping: "always",
	}).format(val);
	// Replace the literal currency code "EUR" with the custom symbol (e.g. "€")
	return ret.replace("EUR", symbol);
}

/**
 * Format a number as an integer (rounded) with locale-aware grouping.
 * Intended for currency-like values where cents are not needed.
 */
export function currency_no_cents(val: number, locale: string = "sl-SI", hide_zero = true): string {
	if (val === undefined) val = 0;

	if (hide_zero && val === 0) return "";
	const ret = cached_number_format(locale, {
		style: "decimal",
		useGrouping: "always",
	}).format(Math.round(val));
	return ret;
}

/**
 * Format a decimal number with locale-aware grouping and configurable fraction digits.
 */
export function decimal(val: number, locale: string = "sl-SI", hide_zero = false, fraction_digits = 2): string {
	if (val === undefined) val = 0;

	if (hide_zero && val === 0) return "";
	const ret = cached_number_format(locale, {
		style: "decimal",
		minimumFractionDigits: fraction_digits,
		useGrouping: "always",
	}).format(val);
	return ret;
}

/**
 * Format a percentage value (e.g., 25 for 25%) with locale-aware grouping.
 * Uses `style: "percent"` internally (divides by 100 per Intl convention).
 */
export function percent(val: number, locale: string = "en-US"): string {
	if (val === undefined) val = 0;
	return cached_number_format(locale, { style: "percent" }).format(val / 100);
}

/**
 * Format a percentage value with configurable fraction digits.
 */
export function display_percent(val: number, locale: string = "en-US"): string {
	if (val === undefined) val = 0;
	return cached_number_format(locale, {
		style: "percent",
		minimumFractionDigits: 0,
		maximumFractionDigits: 2,
	}).format(val / 100);
}

/**
 * Pluralize a pipe-separated translation string using Intl.PluralRules.
 *
 * Translation keys should be 5 pipe-separated plural forms:
 * "zero|one|two|few|other"
 *
 * Example (English):   "0 records|1 record|{count} records|{count} records|{count} records"
 * Example (Slovenian): "0 zapisov|1 zapis|{count} zapisa|{count} zapisi|{count} zapisov"
 *
 * Falls back to the last ("other") form if a form index is missing.
 */
export function plural(translation_string: string, count: number, locale: string = "en-US"): string {
	const plural_rules = cached_plural_rules(locale);
	const nf = cached_number_format(locale);
	const parts = translation_string.split("|");
	const plural_form = plural_rules.select(count);

	const form_index: Record<string, number> = { zero: 0, one: 1, two: 2, few: 3, many: 4, other: 4 };

	const idx = form_index[plural_form] ?? parts.length - 1;
	const selected = parts[idx] ?? parts[parts.length - 1] ?? "";
	return selected.replace("{count}", nf.format(count));
}

/**
 * Format a bulk delete result message using pipe-separated plural translation keys.
 *
 * Composes two separate `plural()` calls:
 * - `msg.bulk_deleted` - pluralized deletion message (pipe-separated, uses {count})
 * - `msg.bulk_errors` - pluralized error suffix (pipe-separated, uses {count})
 *
 * Missing keys fall back to English pipe strings built from `label`.
 */
export function format_bulk_delete_message(
	msg: { bulk_deleted?: string; bulk_errors?: string; },
	deleted_count: number,
	error_count: number,
	label: string = "record",
	locale: string = "en-US",
): string {
	const deleted_key = msg.bulk_deleted || `No ${label}s deleted|{count} ${label} deleted|{count} ${label}s deleted|{count} ${label}s deleted|{count} ${label}s deleted`;
	const deleted_part = plural(deleted_key, deleted_count, locale);

	if (error_count > 0) {
		const errors_key = msg.bulk_errors || `|{count} ${label} failed|{count} ${label}s failed|{count} ${label}s failed|{count} ${label}s failed`;
		const errors_part = plural(errors_key, error_count, locale);
		return `${deleted_part}, ${errors_part}`;
	}

	return deleted_part;
}
