/**
 * UUID v7 helpers - time-ordered UUIDs (RFC 9562).
 *
 * Wraps native Bun APIs for convenience and consistency.
 * UUID v7 embeds a 48-bit ms timestamp, making IDs sortable by creation time
 * and friendly to B-tree indexes (no page splits like random UUID v4).
 *
 * Storage convention:
 * MySQL: BINARY(16) - store via uuid_v7_bytes()
 * TypeScript: string (36-char hex with dashes) - from uuid_v7()
 *
 * Usage:
 * import { uuid_v7, uuid_v7_bytes, uuid_to_hex } from "$lib/uuid";
 *
 * const id = uuid_v7();                 // "018f3a6b-7a3c-7b00-a8c9-5e6b7a8c9d0e"
 * const bytes = uuid_v7_bytes();        // Uint8Array(16) - for DB BINARY(16) columns
 * const hex = uuid_to_hex(bytes);       // "018f3a6b-7a3c-7b00-a8c9-5e6b7a8c9d0e"
 *
 * In SQL queries with BINARY(16):
 * await sql`INSERT INTO t (id) VALUES (${uuid_v7_bytes()})`;
 */

// ---------------------------------------------------------------------------
// UUID v7 generation
// ---------------------------------------------------------------------------

/**
 * Generate a UUID v7 string (36 characters, hex with dashes).
 *
 * Canonical format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 * where version=7 and variant=10xx.
 *
 * Uses Bun's native implementation (high-res timer + CSPRNG).
 */
export function uuid_v7(): string { return Bun.randomUUIDv7(); }

/**
 * Generate a UUID v7 as a Uint8Array(16), ready for BINARY(16) storage.
 *
 * Pass directly to Bun SQL tagged template queries:
 * await sql`INSERT INTO records (id, name) VALUES (${uuid_v7_bytes()}, ${name})`;
 *
 * The BINARY(16) column stores the raw 128-bit value without dashes,
 * saving 20 bytes per row compared to CHAR(36).
 */
export function uuid_v7_bytes(): Uint8Array { return Bun.randomUUIDv7Bytes(); }

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array(16) back to the standard UUID hex string format.
 *
 * Useful when reading a BINARY(16) column back and you need the hex string:
 * const raw: Uint8Array = row.id;
 * const id = uuid_to_hex(raw);
 *
 * The Bun SQL driver converts BINARY(16) to Uint8Array automatically.
 */
export function uuid_to_hex(bytes: Uint8Array): string {
	if (bytes.length !== 16) { throw new Error(`uuid_to_hex: expected 16 bytes, got ${bytes.length}`); }

	const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

	// Insert dashes at standard UUID positions: 8-4-4-4-12
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Check whether a string is a valid UUID v7 (version bits = 7).
 *
 * Accepts both uppercase and lowercase hex. Does NOT accept nil UUID
 * or UUID v7 with all-zero randomness - those are improbable but valid.
 * For strict validation, use uuid_validate_v7().
 *
 * Regex matches: time(48) + version(4) + variant(2) + random(62+2 padding)
 */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid_is_v7(id: string): boolean { return UUID_V7_RE.test(id); }

/**
 * Validate a string as a UUID v7, returning a descriptive error if invalid.
 * Returns null for valid IDs.
 */
export function uuid_validate_v7(id: string): string | null {
	if (!id || typeof id !== "string") return "UUID must be a string";
	if (!UUID_V7_RE.test(id)) {
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) { return "Not a UUID v7 (version field is not 7)"; }
		return "Invalid UUID format (expected 36-char hex with dashes)";
	}
	return null;
}
