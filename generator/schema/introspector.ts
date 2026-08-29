import type { SchemaObject } from "./types";

export interface DbIntrospector {
	get_database_schema(target?: string): Promise<SchemaObject[]>;

	/**
	 * Get all table indexes as a map of table_name -> Set of indexed column names (lowercased).
	 * Includes primary key columns (implicitly indexed).
	 */
	get_all_indexes(): Promise<Map<string, Set<string>>>;

	/**
	 * Names of views that could not be introspected because they reference
	 * missing tables (broken DDL). Populated during get_database_schema() /
	 * get_all_indexes() calls; empty when every view is healthy. Used to
	 * surface a "DDL needs repair" warning in the reeman UI.
	 */
	readonly broken_views: string[];
}
