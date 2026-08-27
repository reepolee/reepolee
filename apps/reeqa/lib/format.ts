/**
 * Format a stored ISO 8601 timestamp for display in ReeQA (a dev tool).
 * Values are stored via Date#toISOString(), so "just slice" the raw string
 * instead of parsing or converting timezones - the output stays UTC, matching
 * what's on disk.
 */
export function iso_datetime(input: string | Date | null | undefined): string {
	if (!input) return "";
	const s = input instanceof Date ? input.toISOString() : String(input);
	// "2026-08-14T09:24:28.123Z" -> "2026-08-14T09:24:28" (ISO 8601, no ms);
	// a date-only "2026-08-14" slices to itself unchanged.
	return s.slice(0, 19);
}
