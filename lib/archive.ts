/**
 * Archive (soft delete) helpers shared by the hand-written reeman features.
 *
 * Generated CRUD emits its own copy of `archive_clause` into each route's
 * `sql.ts` so the generated file stays self-contained and readable on its own.
 * The hand-written apps under `apps/reeman/` have no such constraint, so they
 * import from here instead of carrying five identical copies.
 *
 * See .agents/PLAN_archived_at.md for the design and the decisions behind it.
 */

import { ARCHIVE_SCOPE_ALL, ARCHIVE_SCOPE_ARCHIVED, ARCHIVE_SCOPE_LIVE, ARCHIVE_TIMESTAMP_FIELD } from "$config/db_structure";

/** Which archive state a listing shows. */
export type ArchiveFilter = "live" | "archived" | "all";

/**
 * WHERE fragment selecting an archive state. An empty string means no
 * restriction, so callers must test before pushing it onto a clause list.
 */
export function archive_clause(archive_filter: ArchiveFilter): string {
	if (archive_filter === "all") return "";
	if (archive_filter === "archived") return `${ARCHIVE_TIMESTAMP_FIELD} IS NOT NULL`;
	return `${ARCHIVE_TIMESTAMP_FIELD} IS NULL`;
}

/**
 * Map a resolved `global_scopes.scope_key` to an archive filter.
 *
 * The two reserved keys are interpreted here rather than being used as SQL:
 * their `where_clause` is empty by design. Every other scope key - including an
 * admin-authored ownership scope such as `my_files` - resolves to "live", so a
 * scope can never widen visibility to archived rows by accident.
 */
export function resolve_archive_filter(scope_key: string): ArchiveFilter {
	if (scope_key === ARCHIVE_SCOPE_ARCHIVED) return "archived";
	if (scope_key === ARCHIVE_SCOPE_ALL) return "all";
	return "live";
}

/**
 * True when a scope key is one of the reserved archive keys, which must be
 * skipped when scope clauses are resolved into SQL.
 *
 * `__live` is reserved as well even though it selects the default filter: it
 * exists so a seeded dropdown offers a way back from the archived view, and its
 * `where_clause` is empty like the other two.
 */
export function is_archive_scope_key(scope_key: string): boolean {
	return scope_key === ARCHIVE_SCOPE_ARCHIVED || scope_key === ARCHIVE_SCOPE_ALL || scope_key === ARCHIVE_SCOPE_LIVE;
}

/** Count breakdown rendered above an index grid. */
export interface ArchiveCounts {
	total: number;
	live: number;
	archived: number;
}

/**
 * Build the total/live/archived count query for a table.
 *
 * Deliberately takes no search or filter arguments: a narrowed count is what
 * pagination already reports, and a headline total that moves as the user types
 * is not a total. `scope_clause` is applied because it is an admin-imposed
 * restriction on what this user may see at all.
 */
export function archive_counts_query(table_name: string, scope_clause: string = ""): string {
	const where = scope_clause ? ` WHERE (${scope_clause})` : "";
	const live_sum = `SUM(CASE WHEN ${ARCHIVE_TIMESTAMP_FIELD} IS NULL THEN 1 ELSE 0 END) as live`;
	const archived_sum = `SUM(CASE WHEN ${ARCHIVE_TIMESTAMP_FIELD} IS NOT NULL THEN 1 ELSE 0 END) as archived`;
	return `SELECT COUNT(*) as total, ${live_sum}, ${archived_sum} FROM ${table_name}${where}`;
}

/** Normalize a counts row from either dialect into plain numbers. */
export function to_archive_counts(row: unknown): ArchiveCounts {
	const record = row as { total?: unknown; live?: unknown; archived?: unknown } | undefined;
	return {
		total: Number(record?.total ?? 0),
		live: Number(record?.live ?? 0),
		archived: Number(record?.archived ?? 0),
	};
}
