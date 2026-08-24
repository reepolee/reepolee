/**
 * Compatibility module for Reeman's former metadata-table bootstrap.
 *
 * `db_tables` and `db_routes` are virtual resources: their handlers derive
 * records from the live schema and generated route tree. No database DDL is
 * required for either page.
 */

/** Kept for external callers that still import the old bootstrap hook. */
export async function ensure_reeman_meta_tables(): Promise<void> {
	// Intentionally empty: metadata resources are derived in memory.
}
