/**
 * Template helpers - built-in functions available in .ree templates.
 *
 * Provides formatting, localization, navigation, and UI helpers.
 * All date formatting goes through `format_datetime()`; the per-variant
 * `js_*` names exist only as template-facing closures built in
 * `create_default_helpers()`.
 */

import { DATE_TZ, DATETIME_TZ, TIME_TZ, TIMESTAMP_TZ } from "$config/db";
import { default_language } from "$config/supported_languages";

import { display_currency as _display_currency, display_percent as _display_percent } from "./format";
import { resolve_localized } from "./route_map";
import { to_instant } from "./temporal";

export type TemplateHelpers = Record<string, any>;

// ---------------------------------------------------------------------------
// Consolidated datetime formatting
// ---------------------------------------------------------------------------

// Intl.DateTimeFormat construction is expensive (~tens of us) - memoize per
// (locale, options). Formatting a plain Date through a cached formatter with
// an explicit timeZone is equivalent to Temporal's toLocaleString with the
// same options, at a fraction of the cost.
const _datetime_formats = new Map<string, Intl.DateTimeFormat>();

function cached_datetime_format(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${locale ?? ""}|${JSON.stringify(options)}`;
	let df = _datetime_formats.get(key);
	if (!df) {
		df = new Intl.DateTimeFormat(locale, options);
		_datetime_formats.set(key, df);
	}
	return df;
}

type DatetimeFormat = "date" | "time" | "datetime" | "timestamp";
type DatetimeStyle = "locale" | "iso";

const FORMAT_CONFIGS: Record<DatetimeFormat, { localeOptions: Intl.DateTimeFormatOptions; timeZone: string; }> = {
	date: { localeOptions: { day: "2-digit", month: "2-digit", year: "2-digit" }, timeZone: DATE_TZ },
	time: { localeOptions: { hour: "2-digit", minute: "2-digit" }, timeZone: TIME_TZ },
	datetime: {
		localeOptions: {
			day: "2-digit",
			month: "2-digit",
			year: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		},
		timeZone: DATETIME_TZ,
	},
	timestamp: {
		localeOptions: {
			day: "2-digit",
			month: "2-digit",
			year: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		},
		timeZone: TIMESTAMP_TZ,
	},
};

/**
 * Consolidated date/time formatting function.
 * Replaces 7 individual functions (js_date_to_locale_string, js_datetime_to_iso_string, etc.).
 *
 * @param input - Date, ISO string, or Temporal-like value
 * @param format - "date" | "time" | "datetime" | "timestamp"
 * @param style - "locale" (default) | "iso"
 * @param locale - Locale string (e.g. "sl-SI"), defaults to undefined (Intl default)
 * @returns Formatted string, or "" on error
 */
export function format_datetime(input: unknown, format: DatetimeFormat = "date", style: DatetimeStyle = "locale", locale?: string): string {
	if (input == null || input === "") return "";

	const cfg = FORMAT_CONFIGS[format];
	if (!cfg) return "";

	if (style === "iso") { return format_iso(input, format); }

	// Plain date string shortcut (YYYY-MM-DD with date format)
	if (format === "date" && typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
		try {
			// PlainDate.from validates (throws on impossible dates like 02-30,
			// which new Date() would silently roll over). A plain date has no
			// timezone - format its UTC midnight in UTC so the calendar day is
			// preserved for every locale.
			Temporal.PlainDate.from(input);
			return cached_datetime_format(locale, { ...cfg.localeOptions, timeZone: "UTC" }).format(new Date(`${input}T00:00:00Z`));
		} catch {
			return "";
		}
	}

	const instant = to_instant(input);
	if (!instant) return "";

	try {
		return cached_datetime_format(locale, { ...cfg.localeOptions, timeZone: cfg.timeZone }).format(new Date(instant.epochMilliseconds));
	} catch {
		return "";
	}
}

function format_iso(input: unknown, format: DatetimeFormat): string {
	if (format === "date") {
		if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) { return input; }
		const instant = to_instant(input);
		if (!instant) return "";
		try {
			return instant.toZonedDateTimeISO(DATE_TZ).toPlainDate().toString();
		} catch {
			return "";
		}
	}

	// datetime or timestamp ISO
	const instant = to_instant(input);
	if (!instant) return "";
	try {
		const tz = format === "datetime" ? instant.toZonedDateTimeISO(DATETIME_TZ) : instant.toZonedDateTimeISO(TIMESTAMP_TZ);
		return tz.toPlainDateTime().toString({ smallestUnit: "minute" });
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Non-date helpers
// ---------------------------------------------------------------------------

export function url(p: string): string { return p.startsWith("/") ? p : `/${p}`; }

export function localized_path(canonical_path: string, lang?: string): string {
	const resolved_lang = lang || default_language;
	const localized = resolve_localized(canonical_path, resolved_lang);
	return localized ?? canonical_path;
}

export function nav_label(key: string, nav?: Record<string, any>): string {
	const last_segment = key.split(".").pop()!;
	const missing = `{${last_segment}}`;

	if (!nav || typeof nav !== "object") return missing;
	const parts = key.split(".");
	let current: any = nav;
	for (const part of parts) {
		if (current == null || typeof current !== "object") return missing;
		current = current[part];
	}
	return current != null ? current : missing;
}

export function is_current(url: string, request_url?: string): string {
	if (!request_url) return "nav-item";
	const url_norm = url.replace(/\/+$/g, "").replace(/\/{2,}/g, "/");
	const current = request_url === url_norm || request_url.startsWith(`${url_norm}/`) || request_url.startsWith(`${url_norm}?`);
	return current ? "font-bold nav-item current" : "nav-item";
}

export function pill(text: string, class_name: string): string { return `<div class="${class_name}">${text}</div>`; }

const PILL_YES_NO_LAYOUT = "pill-yes-no-layout";

export type YesNoType = "both" | "yes_only";

export function yes_no(val: number, type: YesNoType = "yes_only", selectors?: Record<string, string>): string {
	const zero_class = type === "both" ? `${PILL_YES_NO_LAYOUT} pill-no` : "bg-transparent";
	const one_class = `${PILL_YES_NO_LAYOUT} pill-yes`;
	const show_zero = type === "both" ? selectors?.["0"] : "";
	const show_one = selectors?.["1"] ?? "";
	return val === 0 ? `${pill(show_zero, zero_class)}</span>` : pill(show_one, one_class);
}

const PILL_TAG_LAYOUT = "pill-layout";

export function tags(val: string, color_class: string = "pill-default", tag_translations?: Record<string, string>): string {
	if (!val) return "";
	return val.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
		const label = tag_translations?.[t] || t;
		return pill(label, `${PILL_TAG_LAYOUT} ${color_class}`);
	}).join(" ");
}

export function key_values(rest: Record<string, any>) {
	return Object.entries(rest).map(([key, value]) => {
		if (value === true) return key;
		if (value === false || value == null) return "";
		return `${key}="${String(value)}"`;
	}).filter(Boolean).join(" ");
}

const IMAGE_THUMBNAIL_SIZE = 100;

// Renders a 100x100 thumbnail for a stored image path (e.g. from <image-upload>).
// Empty/missing value renders a placeholder box so grid rows keep a consistent height.
export function image_thumbnail(src: string, size: number = IMAGE_THUMBNAIL_SIZE): string {
	if (!src) return `<div class="bg-slate-100 rounded" style="width:${size}px;height:${size}px"></div>`;
	return `<img src="${src}" alt="" class="object-cover rounded" style="width:${size}px;height:${size}px" />`;
}

export function human_bytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let value = bytes;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i++;
	}
	return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Check if a filter value is currently active in the URL params.
 * Used by the filter panel to mark checkboxes as checked.
 */
export function is_checked(key: string, value: string | number, filter_params: Record<string, string>): boolean {
	const current = filter_params[key];
	if (!current) return false;
	const values = current.split(",").map((v) => v.trim());
	return values.includes(String(value));
}

export function urlencode(str: string): string { return encodeURIComponent(str ?? ""); }

export function urldecode(str: string): string { return decodeURIComponent(str ?? ""); }

// ---------------------------------------------------------------------------
// Default helpers factory
// ---------------------------------------------------------------------------

export function create_default_helpers(data: any = {}): TemplateHelpers {
	const lang = data.lang || default_language;
	const locale = data.locale;
	const nav = data.translations?.nav;
	const request_url = data.request_url;
	const selectors = data.translations?.selectors;

	return {
		url,
		localized_path: (canonical_path: string) => localized_path(canonical_path, lang),
		nav_label: (key: string) => nav_label(key, nav),
		is_current: (u: string) => is_current(u, request_url),
		is_checked,

		// Date helpers - all delegate to format_datetime
		js_date_to_locale_string: (date_input: string | Date, l: string = locale) => format_datetime(date_input, "date", "locale", l),
		js_time_to_locale_string: (date_input: string | Date, l: string = locale) => format_datetime(date_input, "time", "locale", l),
		js_datetime_to_locale_string: (datetime_input: string | Date, l: string = locale) => format_datetime(datetime_input, "datetime", "locale", l),
		js_timestamp_to_locale_string: (timestamp_input: string | Date, l: string = locale) => format_datetime(timestamp_input, "timestamp", "locale", l),
		js_date_to_iso_string: (date_input: string | Date) => format_datetime(date_input, "date", "iso"),
		js_datetime_to_iso_string: (date_input: string | Date) => format_datetime(date_input, "datetime", "iso"),
		js_timestamp_to_iso_string: (date_input: string | Date) => format_datetime(date_input, "timestamp", "iso"),

		display_currency: (val: number, l: string = locale, hide_zero = false, symbol = "€") => _display_currency(val, l, hide_zero, symbol),
		display_percent: (val: number, l: string = locale) => _display_percent(val, l),
		urlencode,
		urldecode,
		pill,
		tags,
		yes_no: (val: number, type: YesNoType = "both") => yes_no(val, type, selectors),
		human_bytes,
		key_values,
		image_thumbnail,
	};
}

export function create_template_helpers(data: any = {}, custom: Record<string, any> = {}): TemplateHelpers { return { ...create_default_helpers(data), ...custom }; }
