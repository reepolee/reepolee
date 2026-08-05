import type { SQL } from "bun";

import type { DbIntrospector } from "../introspector";
import type { ColumnDef, SchemaObject } from "../types";

interface RawMySQLColumn {
	COLUMN_NAME: string;
	COLUMN_TYPE: string;
	COLUMN_COMMENT: string;
	IS_NULLABLE: string;
	COLUMN_KEY: string;
	EXTRA: string;
}

interface RawForeignKey {
	constraint_name: string;
	column_name: string;
	referenced_table_name: string;
	referenced_column_name: string;
}

export class MySQLIntrospector implements DbIntrospector {
	private db: SQL;

	constructor(db: SQL) { this.db = db; }

	async get_all_indexes(): Promise<Map<string, Set<string>>> {
		const indexes = new Map();

		const raw_indexes = (await this.db`
			SELECT TABLE_NAME, COLUMN_NAME
			FROM INFORMATION_SCHEMA.STATISTICS
			WHERE TABLE_SCHEMA = DATABASE()
		`) as any[];

		for (const row of raw_indexes) {
			const table = row.TABLE_NAME;
			if (!indexes.has(table)) { indexes.set(table, new Set()); }
			indexes.get(table)?.add(row.COLUMN_NAME.toLowerCase());
		}

		return indexes;
	}

	async get_database_schema(target?: string): Promise<SchemaObject[]> {
		const tables_result = (await this.db`
			SELECT TABLE_NAME as name, TABLE_TYPE as type, TABLE_COMMENT as comment
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
		`) as any[];

		const view_set_result = (await this.db`
			SELECT TABLE_NAME as name
			FROM INFORMATION_SCHEMA.TABLES
			WHERE TABLE_SCHEMA = DATABASE()
			AND TABLE_TYPE = 'VIEW'
		`) as any[];

		const view_set = new Set(view_set_result.map((v) => v.name));

		const schema_objects: SchemaObject[] = [];

		for (const table of tables_result) {
			const is_view = table.type === "VIEW";

			const raw_columns = (await this.db`
				SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT, IS_NULLABLE, COLUMN_KEY, EXTRA
				FROM INFORMATION_SCHEMA.COLUMNS
				WHERE TABLE_SCHEMA = DATABASE()
				AND TABLE_NAME = ${table.name}
			`) as RawMySQLColumn[];

			const columns = raw_columns.map((col) => ({
				name: col.COLUMN_NAME,
				type_string: col.COLUMN_TYPE,
				comment: col.COLUMN_COMMENT,
				is_nullable: col.IS_NULLABLE === "YES",
				is_primary_key: col.COLUMN_KEY === "PRI",
				is_auto_increment: col.EXTRA.includes("auto_increment"),
				is_generated: col.EXTRA.includes("VIRTUAL GENERATED") || col.EXTRA.includes("STORED GENERATED"),
			}));

			const foreign_keys = is_view ? [] : ((await this.db`
					SELECT
						kcu.CONSTRAINT_NAME AS constraint_name,
						kcu.COLUMN_NAME AS column_name,
						kcu.REFERENCED_TABLE_NAME AS referenced_table_name,
						kcu.REFERENCED_COLUMN_NAME AS referenced_column_name
					FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
					JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
						ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
						AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
					WHERE kcu.TABLE_SCHEMA = DATABASE()
						AND kcu.TABLE_NAME = ${table.name}
						AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
				`) as RawForeignKey[]);

			const view_name = `v_${table.name}`;

			let view_columns: ColumnDef[] | undefined;
			if (view_set.has(view_name)) {
				// A broken view (referencing dropped tables) can make MariaDB
				// error on column resolution - skip it rather than abort.
				try {
					const raw_view_cols = (await this.db`
						SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT, IS_NULLABLE, COLUMN_KEY, EXTRA
						FROM INFORMATION_SCHEMA.COLUMNS
						WHERE TABLE_SCHEMA = DATABASE()
						AND TABLE_NAME = ${view_name}
					`) as RawMySQLColumn[];

					view_columns = raw_view_cols.map((col) => ({
						name: col.COLUMN_NAME,
						type_string: col.COLUMN_TYPE,
						comment: col.COLUMN_COMMENT,
						is_nullable: col.IS_NULLABLE === "YES",
						is_primary_key: col.COLUMN_KEY === "PRI",
						is_auto_increment: col.EXTRA.includes("auto_increment"),
						is_generated: col.EXTRA.includes("VIRTUAL GENERATED") || col.EXTRA.includes("STORED GENERATED"),
					}));
				} catch (err) {
					console.warn(`[introspect] Skipping broken view "${view_name}": ${err instanceof Error ? err.message : err}`);
					view_columns = undefined;
				}
			}

			schema_objects.push({
				type: is_view ? "view" : "table",
				name: table.name,
				comment: table.comment,
				columns,
				view_columns,
				foreign_keys,
				has_view: view_set.has(view_name),
			});
		}

		return schema_objects;
	}
}
