/**
 * Template helpers - built-in functions available in .ree templates.
 *
 * Provides formatting, localization, navigation, and UI helpers.
 * All date formatting goes through `format_datetime()`; the per-variant
 * `js_*` names exist only as template-facing closures built in
 * `create_default_helpers()`.
 */

import { DATE_TZ, DATETIME_TZ, TIME_TZ, TIMESTAMP_TZ } from "$config/db";
import { default_locale } from "$config/supported_locales";

import { cn as _cn, type Cn_input } from "./cn";

import { display_currency as _display_currency, display_percent as _display_percent } from "./format";
import { format_bcp47, format_og_locale, locale_short_code } from "./locale";
import { resolve_localized, resolve_localized_path } from "./route_map";
import { now_today, to_instant } from "./temporal";
import { render_icon } from "./ree_icon";

export type TemplateHelpers = Record<string, any>;

export function cn(...inputs: Cn_input[]): string { return _cn(...inputs); }

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
 * @param locale - Locale string (e.g. "sl-si"), defaults to undefined (Intl default)
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

export function unix_timestamp_to_locale_string(timestamp_input: unknown, locale?: string): string {
	if (typeof timestamp_input !== "number" || !Number.isFinite(timestamp_input)) return "";

	const timestamp_date = new Date(timestamp_input * 1000);
	return format_datetime(timestamp_date, "timestamp", "locale", locale);
}

type Duration_format_style = NonNullable<Intl.DurationFormatOptions["style"]>;

export function iso_duration_to_locale_string(duration_input: unknown, style: Duration_format_style = "short", locale?: string): string {
	if (duration_input == null || duration_input === "") return "";

	try {
		const duration = typeof duration_input === "number"
			? Temporal.Duration.from({ seconds: duration_input }).round({ largestUnit: "days" })
			: Temporal.Duration.from(duration_input);
		const formatter = new Intl.DurationFormat(locale, { style });
		return formatter.format(duration);
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

function split_query(path: string): { path_only: string; query_string: string; } {
	const query_index = path.indexOf("?");
	return {
		path_only: query_index === -1 ? path : path.slice(0, query_index),
		query_string: query_index === -1 ? "" : path.slice(query_index),
	};
}

export function localized_path(canonical_path: string, locale?: string): string {
	const resolved_lang = locale || default_locale;
	const { path_only, query_string } = split_query(canonical_path);
	const localized = resolve_localized(path_only, resolved_lang);
	return (localized ?? path_only) + query_string;
}

function resolve_localized_path_safe(path: string, target_locale: string): string | null {
	try {
		return resolve_localized_path(path, target_locale);
	} catch {
		// Route maps not built yet (early renders, unit tests) - the only case
		// resolve_localized_path throws today. Treat the path as unmapped so
		// the caller falls back to the input unchanged.
		return null;
	}
}

/**
 * Map a path (canonical, or already localized in some locale) to its spelling
 * in `target_locale`, preserving query strings.
 *
 * Used for hreflang alternates: the current URL may itself be localized, so
 * the mapping resolves back to the canonical route before localizing again.
 * Falls back to the input path when unmapped or when route maps are not built.
 */
export function localized_path_for_locale(target_locale: string, path: string): string {
	const { path_only, query_string } = split_query(path);
	const localized = resolve_localized_path_safe(path_only, target_locale);
	return (localized ?? path_only) + query_string;
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

/**
 * Whether the user's modules_tags grant `module_code`. Exact tag match so
 * "admin" never matches "administrator" - same semantics as
 * `has_module()` in routes/system/auth/middleware.ts, which gates routes.
 * A null/undefined requirement is always granted (public entry); anonymous
 * users carry no modules.
 */
export function user_has_module(user: Record<string, any> | null | undefined, module_code: string | null | undefined): boolean {
	if (!module_code) return true;
	const tags = (user?.modules_tags || "").split(/[\s,]+/).filter(Boolean);
	return tags.includes(module_code);
}

export function is_current(url: string, request_url?: string, exact = false): string {
	if (!request_url) return "nav-item";
	// Root "/" must stay "/": trailing-slash stripping would reduce it to "",
	// and "".replace -> "/" is a prefix of every URL, marking the dashboard
	// (or any root nav entry) as current on every page. Root matches exactly
	// (or with a query string) only - it is never a parent of sub-pages.
	const url_norm = url === "/" ? "/" : url.replace(/\/+$/g, "").replace(/\/{2,}/g, "/");
	const exact_current = request_url === url_norm || request_url.startsWith(`${url_norm}?`);
	const current = exact ? exact_current : exact_current || (url_norm !== "/" && request_url.startsWith(`${url_norm}/`));
	return current ? "font-bold nav-item current" : "nav-item";
}

export function pill(text: string, class_name: string): string { return `<div class="${class_name}">${text}</div>`; }

const PILL_YES_NO_LAYOUT = "pill-yes-no-layout";

export type YesNoType = "both" | "yes_only";

export function yes_no(val: number, type: YesNoType = "yes_only", selectors?: Record<string, string>): string {
	const zero_class = type === "both" ? `${PILL_YES_NO_LAYOUT} pill-no` : "bg-transparent";
	const one_class = `${PILL_YES_NO_LAYOUT} pill-yes`;
	const show_zero = type === "both" ? selectors?.["0"] ?? "" : "";
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

// Extension -> <ree-icon> name for recognized document types. Falls back to "file".
const FILE_ICON_BY_EXT: Record<string, string> = {
	pdf: "file_pdf",
	doc: "file_word",
	docx: "file_word",
	xls: "file_excel",
	xlsx: "file_excel",
	csv: "file_csv",
	ppt: "file_powerpoint",
	pptx: "file_powerpoint",
	zip: "file_zip",
	txt: "file_text",
};

// Resolve the <ree-icon> name for a filename/path based on its extension.
export function file_icon_name(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase() || "";
	return FILE_ICON_BY_EXT[ext] || "file";
}

// Renders a filename/download link for a stored file path (e.g. from <file-upload>).
// Empty/missing value renders an em-dash so grid rows keep a consistent look.
export function file_link(src: string): string {
	if (!src) return `<span class="text-slate-400">-</span>`;
	const filename = src.split("/").pop() || src;
	return `<a href="${src}" target="_blank" rel="noopener" class="text-brand underline truncate block" title="${filename}">${filename}</a>`;
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

// Renders Markdown source (e.g. a CMS `markdown` field) to HTML.
// Use with unescaped output ({~ md(...) }) so the generated markup isn't escaped.
// Template strings may contain a literal `\\n`, which is normalized before parsing.
export function md(source: string): string {
	if (!source) return "";
	const normalized = String(source).replace(/\\\\n/g, "\n");
	return Bun.markdown.html(normalized, {
		tables: true,
		strikethrough: true,
		autolinks: { url: true, www: true, email: true },
	});
}

// ---------------------------------------------------------------------------
// Default helpers factory
// ---------------------------------------------------------------------------

export function create_default_helpers(data: any = {}): TemplateHelpers {
	const locale = data.locale || default_locale;
	const nav = data.translations?.nav;
	const request_url = data.request_url;
	const selectors = data.translations?.selectors;
	const exact_nav = data.exact_nav === true;

	return {
		url,
		localized_path: (canonical_path: string) => localized_path(canonical_path, locale),
		localized_path_for_locale,
		format_bcp47,
		format_og_locale,
		locale_short_code,
		nav_label: (key: string) => nav_label(key, nav),
		is_current: (u: string) => is_current(u, request_url, exact_nav),
		user_has_module,
		is_checked,

		// Date helpers - all delegate to format_datetime
		js_date_to_locale_string: (date_input: string | Date, l: string = locale) => format_datetime(date_input, "date", "locale", l),
		js_time_to_locale_string: (date_input: string | Date, l: string = locale) => format_datetime(date_input, "time", "locale", l),
		js_datetime_to_locale_string: (datetime_input: string | Date, l: string = locale) => format_datetime(datetime_input, "datetime", "locale", l),
		js_timestamp_to_locale_string: (timestamp_input: string | Date, l: string = locale) => format_datetime(timestamp_input, "timestamp", "locale", l),
		unix_timestamp_to_locale_string: (timestamp_input: unknown, l: string = locale) => unix_timestamp_to_locale_string(timestamp_input, l),
		iso_duration_to_locale_string: (duration_input: unknown, style: Duration_format_style = "short") => iso_duration_to_locale_string(duration_input, style, locale),
		js_date_to_iso_string: (date_input: string | Date) => format_datetime(date_input, "date", "iso"),
		js_datetime_to_iso_string: (date_input: string | Date) => format_datetime(date_input, "datetime", "iso"),
		js_timestamp_to_iso_string: (date_input: string | Date) => format_datetime(date_input, "timestamp", "iso"),
		now_today,

		display_currency: (val: number, l: string = locale, hide_zero = false, symbol = "€") => _display_currency(val, l, hide_zero, symbol),
		display_percent: (val: number, l: string = locale) => _display_percent(val, l),
		urlencode,
		urldecode,
		md,
		pill,
		tags,
		yes_no: (val: number, type: YesNoType = "both") => yes_no(val, type, selectors),
		human_bytes,
		key_values,
		image_thumbnail,
		file_link,
		file_icon_name,
		render_icon,
		cn,
	};
}

export function create_template_helpers(data: any = {}, custom: Record<string, any> = {}): TemplateHelpers { return { ...create_default_helpers(data), ...custom }; }
