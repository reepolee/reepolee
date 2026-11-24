/**
 * UUID v7 helpers - time-ordered UUIDs (RFC 9562).
 *
 * Wraps native Bun APIs for convenience and consistency.
 * UUID v7 embeds a 48-bit ms timestamp, making IDs sortable by creation time
 * and friendly to B-tree indexes (no page splits like random UUID v4).
 */

/**
 * Generate a UUID v7 string (36 characters, hex with dashes).
 *
 * Canonical format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 * where version=7 and variant=10xx.
 *
 * Uses Bun's native implementation (high-res timer + CSPRNG).
 */
export function uuid_v7(): string { return Bun.randomUUIDv7(); }
