/**
 * Central Temporal polyfill setup + date/time formatting helpers.
 *
 * Import this module as early as possible in any file that uses `globalThis.Temporal`
 * to ensure the polyfill is loaded and the global is set before the importing
 * module's own top-level code runs.
 *
 * Usage:
 * import "$lib/temporal";                                    // side-effect only
 * import { Temporal, now_epoch_ms } from "$lib/temporal";    // explicit import
 */
import { Temporal as PolyfillTemporal } from "$vendor/temporal.min";
globalThis.Temporal = PolyfillTemporal as any;
export { PolyfillTemporal as Temporal };

// Convenience helpers

// Current time as Unix epoch milliseconds (equivalent to Date.now()).
export function now_epoch_ms(): number { return Temporal.Now.instant().epochMilliseconds; }

// Today's date as "YYYY-MM-DD".
export function now_today(): string { return Temporal.Now.instant().toString().slice(0, 10); }

// Current UTC instant as a full ISO 8601 string.
export function now_iso_str(): string { return Temporal.Now.instant().toString(); }

// Current year as a number (4 digits).
export function now_year(): number { return Number(Temporal.Now.instant().toString().slice(0, 4)); }

/**
 * Current time-of-day as "HH:MM:SS" or "HH:MM:SS.mmm" string.
 * The value is always UTC - for local-time display use locale_time() in template_helpers. */
export function now_time_str(include_millis = false): string {
	const str = Temporal.Now.instant().toString({ smallestUnit: include_millis ? "millisecond" : "second" });
	return str.slice(11, include_millis ? 23 : 19);
}

// Convert a native JS Date to a Temporal.Instant.
export function date_to_instant(date: Date): Temporal.Instant { return Temporal.Instant.from(date.toISOString()); }

// Format a Date as a local-time "YYYY-MM-DD HH:MM:SS" string (sv-SE locale trick).
export function local_js_datetime_to_iso_string(date = new Date()): string {
	return date.toLocaleString("sv-SE", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).replace(",", "").replace(/\s+/g, " ").trim();
}

/**
 * Format a Temporal.Instant (or now) as an SQL-friendly datetime string
 * "YYYY-MM-DD HH:MM:SS" (MySQL format, no timezone suffix).
 */
export function instant_to_sql(instant?: Temporal.Instant): string {
	const i = instant ?? Temporal.Now.instant();
	return i.toString({ smallestUnit: "second" }).replace("T", " ").replace("Z", "");
}

/**
 * Convert SQL UTC datetime/string to
 * <input type="datetime-local"> format
 *
 * Example:
 * 2026-05-20T00:02:00.000Z
 * -> 2026-05-20T02:02
 */
export function sql_to_datetime_local(value: string | Date | null | undefined, timezone = Bun.env.TIME_ZONE): string {
	if (!value) return "";

	const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();

	return Temporal.Instant.from(iso)
		.toZonedDateTimeISO(timezone)
		.toPlainDateTime()
		.toString({ smallestUnit: "minute" });
}

export function to_instant(input: unknown): Temporal.Instant | null {
	if (input == null || input === "") return null;

	if (input instanceof Temporal.Instant) { return input; }

	if (input instanceof Date) { return Temporal.Instant.fromEpochMilliseconds(input.getTime()); }

	if (typeof input === "string") { return string_to_instant(input); }

	throw new Error("Unsupported date type");
}

const ISO_FULL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const SQL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function string_to_instant(value: string): Temporal.Instant | null {
	if (!value) return null;

	value = value.trim();

	if (ISO_FULL_RE.test(value)) {
		try {
			return Temporal.Instant.from(value);
		} catch {
			return null;
		}
	}

	if (SQL_DATETIME_RE.test(value)) { value = value.replace(" ", "T"); }

	if (DATETIME_LOCAL_RE.test(value)) {
		try {
			return Temporal.PlainDateTime.from(value).toZonedDateTime("UTC").toInstant();
		} catch {
			return null;
		}
	}

	return null;
}
