import { z } from "$vendor/zod.min.js";

import { sql_to_datetime_local } from "./temporal";

function get_issues(result: any): Array<{ path: string[]; message: string; }> { return result?.error?.issues ?? []; }

export const z_date_required = z.string({
	required_error: "required",
	invalid_type_error: "required",
}).nullish().refine((val) => val != null && val !== "", { message: "required" }).pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "invalid_date"));

export const z_date_optional = z.string()
	.nullish()
	.refine((val) => val == null || val === "" || /^\d{4}-\d{2}-\d{2}$/.test(val), { message: "invalid_date" })
	.transform((val) => (val === "" ? null : val));

export const z_datetime_optional = z.string()
	.nullish()
	.refine((val) => val == null || val === "" || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(val), { message: "invalid_datetime" })
	.transform((val) => (val === "" ? null : val));

export const z_datetime_required = z.string({
	required_error: "required",
	invalid_type_error: "required",
}).min(1, "required").datetime({
	local: true,
	message: "invalid_datetime",
}).nullish().refine((val) => val != null && val !== "", { message: "required" });

export function validate_schema<T extends z.ZodTypeAny>(schema: T, data: unknown, touched?: string[], messages?: Record<string, string>): [Record<string, string>, z.output<T> | undefined] {
	const errors: Record<string, string> = {};

	const result = schema.safeParse(data);

	if (!result.success) {
		for (const err of get_issues(result)) {
			const field = err.path[0] as string;

			if (!touched || touched.includes(field)) { errors[field] = messages?.[err.message] ?? err.message; }
		}
	}

	const valid_data = result.data ?? null;

	return [errors, valid_data];
}

function to_date_local(value: Date) {
	// DATE columns have no time component - just return the wall-clock date as-is.
	// No timezone conversion needed since a date is timezone-agnostic.
	return extract_utc_wall_clock(value).slice(0, 10);
}

// TIMESTAMP columns (e.g. created_at, updated_at) - always stored as UTC by the DB.
// MySQL session time_zone='+00:00' returns "YYYY-MM-DD HH:MM:SS" (UTC wall-clock).
// Bun's MySQL driver converts this to a Date via `new Date(string)`, which
// JavaScriptCore interprets as local time. Local getters recover the original
// UTC wall-clock values because `new Date(string)` stores the string's components
// as local time components.

function extract_utc_wall_clock(val: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	// Use local getters: they preserve the original MySQL string values even
	// though the Date's epoch was shifted by the local timezone offset.
	return `${val.getFullYear()}-${pad(val.getMonth() + 1)}-${pad(val.getDate())} ${pad(val.getHours())}:${pad(val.getMinutes())}:${pad(val.getSeconds())}`;
}

export const empty_string = z.codec(z.union([z.string(), z.null()]), z.string().nullable(), {
	decode: (val) => {
		if (val === "" || val == null) return null;
		return val;
	},
	encode: (val) => { return val ?? null; },
});

/**
 * Unified date codec - handles both MySQL (Date input) and SQLite (string input).
 * Decodes to "YYYY-MM-DD" for form display.
 */
export const date_codec = z.codec(z.union([z.instanceof(Date), z.string(), z.null()]), z.string().nullable(), {
	decode: (val) => {
		if (val == null || val === "") return null;
		if (val instanceof Date) return to_date_local(val);
		return String(val).slice(0, 10);
	},
	encode: (val) => val ?? null,
});

/**
 * Unified datetime codec - handles both MySQL (Date input) and SQLite (string input).
 * Decodes to "YYYY-MM-DDTHH:MM" (local TZ) for <input type="datetime-local">.
 */
export const datetime_codec = z.codec(
	z.union([z.instanceof(Date), z.string(), z.null()]),
	z.string().nullable(),
	{
		decode: (val) => {
			if (val == null || val === "") return null;
			try {
				if (val instanceof Date) { return sql_to_datetime_local(val); }

				return sql_to_datetime_local(String(val));
			} catch {
				return null;
			}
		},
		encode: (val) => val ?? null,
	}
);

/**
 * Unified timestamp codec - handles both MySQL (Date input) and SQLite (string input).
 * Decodes to UTC wall-clock string ("YYYY-MM-DD HH:MM:SS") for display.
 */
export const timestamp_codec = z.codec(z.union([z.instanceof(Date), z.string(), z.null()]), z.string().nullable(), {
	decode: (val) => {
		if (val == null || val === "") return null;
		if (val instanceof Date) return extract_utc_wall_clock(val);
		return String(val);
	},
	encode: (val) => val ?? null,
});
