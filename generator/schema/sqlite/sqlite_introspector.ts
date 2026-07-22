import type { SQL } from "bun";

import type { DbIntrospector } from "../introspector";
import type { ColumnDef, ForeignKeyDef, SchemaObject } from "../types";

interface RawSQLiteColumn {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
	hidden: number;
}

interface RawSQLiteForeignKey {
	id: number;
	seq: number;
	table: string;
	from: string;
	to: string;
	on_update: string;
	on_delete: string;
	match: string;
}

export class SQLiteIntrospector implements DbIntrospector {
	private db: SQL;

	constructor(db: SQL) { this.db = db; }

	async get_all_indexes(): Promise<Map<string, Set<string>>> {
		const indexes = new Map();

		const tables = (await this.db`
			SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
		`) as any[];

		for (const table of tables) {
			const table_name = table.name;
			const col_set = new Set();

			// Primary key columns are auto-indexed in SQLite
			const pragma_info = (await this.db.unsafe(`PRAGMA table_xinfo(${table_name})`)) as any[];
			for (const col of pragma_info) {
				if (col.pk > 0) { col_set.add(col.name.toLowerCase()); }
			}

			// Explicit indexes
			const index_list = (await this.db.unsafe(`PRAGMA index_list(${table_name})`)) as any[];
			for (const idx of index_list) {
				const index_info = (await this.db.unsafe(`PRAGMA index_info(${idx.name})`)) as any[];
				for (const info of index_info) {
					col_set.add(info.name.toLowerCase());
				}
			}

			indexes.set(table_name, col_set);
		}

		return indexes;
	}

	async get_database_schema(target?: string): Promise<SchemaObject[]> {
		const tables_result = (await this.db`
			SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
		`) as any[];

		const views_result = (await this.db`
			SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name
		`) as any[];

		const view_set = new Set(views_result.map((v) => v.name));
		const schema_objects: SchemaObject[] = [];

		for (const table of tables_result) {
			const table_name = table.name;

			const raw_columns = (await this.db.unsafe(`PRAGMA table_xinfo(${table_name})`)) as RawSQLiteColumn[];

			const columns = raw_columns.filter((col) => !(col.pk > 0)).map((col) => ({
				name: col.name,
				type_string: col.type,
				comment: "",
				is_nullable: col.notnull === 0,
				is_primary_key: col.pk > 0,
				is_auto_increment: col.pk > 0,
				is_generated: col.hidden > 0,
			}));

			const raw_foreign_keys = (await this.db.unsafe(`PRAGMA foreign_key_list(${table_name})`)) as RawSQLiteForeignKey[];

			const foreign_keys: ForeignKeyDef[] = raw_foreign_keys.map((fk) => ({
				constraint_name: `fk_${table_name}_${fk.from}`,
				column_name: fk.from,
				referenced_table_name: fk.table,
				referenced_column_name: fk.to,
			}));

			const view_name = `v_${table_name}`;
			let has_view = view_set.has(view_name);

			let view_columns: ColumnDef[] | undefined;
			if (has_view) {
				// PRAGMA table_xinfo on a view resolves the view's definition -
				// a view referencing a missing table (e.g. a dev DB carrying
				// MySQL-only views) throws "no such table". Skip such views
				// instead of aborting the whole introspection.
				try {
					const raw_view_cols = (await this.db.unsafe(`PRAGMA table_xinfo(${view_name})`)) as RawSQLiteColumn[];

					view_columns = raw_view_cols.filter((col) => col.name !== "id").map((col) => ({
						name: col.name,
						type_string: col.type,
						comment: "",
						is_nullable: col.notnull === 0,
						is_primary_key: col.pk > 0,
						is_auto_increment: col.pk > 0,
						is_generated: col.hidden > 0,
					}));
				} catch (err) {
					console.warn(`[introspect] Skipping broken view "${view_name}": ${err instanceof Error ? err.message : err}`);
					has_view = false;
					view_columns = undefined;
				}
			}

			schema_objects.push({
				type: "table",
				name: table_name,
				comment: "",
				columns,
				view_columns,
				foreign_keys,
				has_view,
			});
		}

		return schema_objects;
	}
}
