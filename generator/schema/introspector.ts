import type { SchemaObject } from "./types";

export interface DbIntrospector {
	get_database_schema(target?: string): Promise<SchemaObject[]>;

	/**
	 * Get all table indexes as a map of table_name -> Set of indexed column names (lowercased).
	 * Includes primary key columns (implicitly indexed).
	 */
	get_all_indexes(): Promise<Map<string, Set<string>>>;
}
