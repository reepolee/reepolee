import type { SQL } from "bun";

import type { DbIntrospector } from "../introspector";
import type { ColumnDef, PrimaryKeyInfo, SchemaObject } from "../types";

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

	// Names of views that could not be introspected (they reference tables that
	// no longer exist). Collected so the reeman UI can warn that the DDL needs
	// repair.
	private _broken_views = new Set<string>();

	constructor(db: SQL) { this.db = db; }

	get broken_views(): string[] { return [...this._broken_views].sort(); }

	private record_broken_view(name: string, err: unknown): void {
		this._broken_views.add(name);
		console.warn(`[introspect] Skipping broken view "${name}": ${err instanceof Error ? err.message : err}`);
	}

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

			const raw_unique_columns = (await this.db`
				SELECT DISTINCT s.COLUMN_NAME
				FROM INFORMATION_SCHEMA.STATISTICS s
				WHERE s.TABLE_SCHEMA = DATABASE()
				AND s.TABLE_NAME = ${table.name}
				AND s.NON_UNIQUE = 0
			`) as Array<{ COLUMN_NAME: string }>;
			const unique_columns = raw_unique_columns.map((col) => col.COLUMN_NAME);

			const columns = raw_columns.map((col) => ({
				name: col.COLUMN_NAME,
				type_string: col.COLUMN_TYPE,
				comment: col.COLUMN_COMMENT,
				is_nullable: col.IS_NULLABLE === "YES",
				is_primary_key: col.COLUMN_KEY === "PRI",
				is_auto_increment: col.EXTRA.includes("auto_increment"),
				is_unique: col.COLUMN_KEY === "UNI" || col.COLUMN_KEY === "PRI",
				is_generated: col.EXTRA.includes("VIRTUAL GENERATED") || col.EXTRA.includes("STORED GENERATED"),
			}));

			// PK columns stay in `columns` for MySQL (generate_fields_object
			// filters them out), but the key's auto-increment-ness is also
			// recorded explicitly so the SQLite/MySQL paths agree on how a table
			// declares its primary key.
			const pk_column = raw_columns.find((col) => col.COLUMN_KEY === "PRI");
			const primary_key: PrimaryKeyInfo | undefined = pk_column
				? {
					name: pk_column.COLUMN_NAME,
					type_string: pk_column.COLUMN_TYPE,
					is_auto_increment: pk_column.EXTRA.includes("auto_increment"),
				}
				: undefined;

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
					this.record_broken_view(view_name, err);
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
				unique_columns,
				has_view: view_set.has(view_name),
				primary_key,
			});
		}

		return schema_objects;
	}
}
