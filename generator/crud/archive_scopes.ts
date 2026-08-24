/**
 * Seed the global scope rows declared by a generated CRUD route.
 *
 * The declaration lives in the route's `schema/table.ts` as a `global_scopes`
 * const - that is the source of truth, and this is the only writer of rows
 * from it. Seeding is automatic for every archivable top-level route: a table
 * carrying `archived_at` scaffolds the three reserved keys (`__live`,
 * `__archived`, `__all`) and a developer may add their own keys (with a
 * `where_clause`) for custom views.
 *
 * Existing rows are left exactly as they are: the unique key is
 * (module_code, feature_name, table_name, scope_key), and an admin may have
 * renamed a display_name or reordered the dropdown since the last run.
 *
 * See .agents/PLAN_archived_at.md (M9) for the original decision, amended to
 * auto-seed from the declaration.
 */

import { db_cli } from "$config/db_cli";

import { log_step } from "./helpers";

export interface ArchiveScopeTarget {
	/** Actual DB table, matching `TABLE_NAME` in the route's sql.ts. */
	table_name: string;
	/** Route directory name - `feature_name` in global_scopes. */
	feature_name: string;
	/** Route prefix without slashes, empty for an unprefixed route. */
	module_code: string;
}

/** One declared scope entry, as written in a route's schema/table.ts. */
export interface ScopeSeed {
	scope_key: string;
	display_name: string;
	where_clause?: string;
	sort_order?: number;
	is_default?: boolean;
}

/**
 * Insert the missing scope rows for one route. Returns how many rows were
 * written.
 */
export async function seed_archive_scopes(target: ArchiveScopeTarget, scopes: ScopeSeed[]): Promise<number> {
	const { table_name, feature_name, module_code } = target;
	let inserted = 0;

	for (let i = 0; i < scopes.length; i++) {
		const seed = scopes[i]!;
		const existing = await db_cli`SELECT id FROM global_scopes WHERE module_code = ${module_code} AND feature_name = ${feature_name} AND table_name = ${table_name} AND scope_key = ${seed.scope_key} LIMIT 1`;
		const existing_rows = existing as unknown as { id: number; }[];
		if (existing_rows.length > 0) continue;

		await db_cli`INSERT INTO global_scopes (module_code, feature_name, table_name, scope_key, display_name, where_clause, sort_order, is_default) VALUES (${module_code}, ${feature_name}, ${table_name}, ${seed.scope_key}, ${seed.display_name}, ${seed.where_clause ?? ""}, ${seed.sort_order ?? i}, ${seed.is_default ? 1 : 0})`;
		inserted++;
	}

	log_step(`Global scopes for ${feature_name}: ${inserted} row(s) inserted, ${scopes.length - inserted} already present`);
	return inserted;
}
