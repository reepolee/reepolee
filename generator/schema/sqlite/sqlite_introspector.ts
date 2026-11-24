import type { SQL } from "bun";

import type { DbIntrospector } from "../introspector";
import type { ColumnDef, ForeignKeyDef, PrimaryKeyInfo, SchemaObject } from "../types";

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

	// Names of views that could not be introspected (they reference tables that
	// no longer exist). Collected across all skip sites so the reeman UI can
	// warn that the DDL needs repair. Deduplicated because the same broken view
	// can be hit from more than one loop (index scan + companion view + standalone).
	private _broken_views = new Set<string>();

	constructor(db: SQL) { this.db = db; }

	get broken_views(): string[] { return [...this._broken_views].sort(); }

	private record_broken_view(name: string, err: unknown): void {
		this._broken_views.add(name);
		console.warn(`[introspect] Skipping broken view "${name}": ${err instanceof Error ? err.message : err}`);
	}

	async get_all_indexes(): Promise<Map<string, Set<string>>> {
		const indexes = new Map();

		const tables = (await this.db`
			SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
		`) as any[];

		for (const table of tables) {
			const table_name = table.name;
			const col_set = new Set();

			// A broken view (referencing a missing table) is listed here as a
			// "table"; PRAGMA table_xinfo on it throws. Skip it so the whole
			// introspection (and the reeman server that triggers it) survives
			// and the DDL can be repaired from the UI.
			let pragma_info: any[];
			try {
				pragma_info = (await this.db.unsafe(`PRAGMA table_xinfo(${table_name})`)) as any[];
			} catch (err) {
				this.record_broken_view(table_name, err);
				continue;
			}
			for (const col of pragma_info) {
				if (col.pk > 0) { col_set.add(col.name.toLowerCase()); }
			}

			// Explicit indexes
			let index_list: any[];
			try {
				index_list = (await this.db.unsafe(`PRAGMA index_list(${table_name})`)) as any[];
			} catch {
				continue;
			}
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
				is_unique: col.pk > 0,
				is_generated: col.hidden > 0,
			}));

			// PK columns are dropped from `columns` (the generated fields never
			// edit them), so the key's shape is recorded separately. `pk > 0`
			// marks any single-column PK in SQLite, which is why the naive
			// `is_auto_increment: col.pk > 0` above would wrongly treat a TEXT
			// key like `meta_key` as auto-increment - only `INTEGER PRIMARY KEY`
			// is the rowid alias, so auto-increment is decided from the type.
			const pk_columns = raw_columns.filter((col) => col.pk > 0);
			const primary_key: PrimaryKeyInfo | undefined = pk_columns.length === 1
				? {
					name: pk_columns[0]!.name,
					type_string: pk_columns[0]!.type,
					is_auto_increment: pk_columns[0]!.type.trim().toUpperCase() === "INTEGER",
				}
				: undefined;

			const raw_foreign_keys = (await this.db.unsafe(`PRAGMA foreign_key_list(${table_name})`)) as RawSQLiteForeignKey[];

			const unique_columns = new Set<string>();
			for (const index of (await this.db.unsafe(`PRAGMA index_list(${table_name})`)) as any[]) {
				if (index.unique !== 1 && String(index.origin || "") !== "pk") continue;
				for (const info of (await this.db.unsafe(`PRAGMA index_info(${index.name})`)) as any[]) {
					if (info.name) unique_columns.add(String(info.name));
				}
			}

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
					this.record_broken_view(view_name, err);
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
				unique_columns: [...unique_columns],
				has_view,
				primary_key,
			});
		}

		for (const view of views_result) {
			const view_name = view.name;

			// A standalone view referencing a missing table (e.g. a locale
			// clone whose base table was dropped) makes PRAGMA table_xinfo
			// throw "no such table". Skip it instead of aborting the whole
			// introspection - the reeman UI must stay reachable so the DDL
			// can be repaired from there.
			let raw_view_columns: RawSQLiteColumn[];
			try {
				raw_view_columns = (await this.db.unsafe(`PRAGMA table_xinfo(${view_name})`)) as RawSQLiteColumn[];
			} catch (err) {
				this.record_broken_view(view_name, err);
				continue;
			}

			const view_columns = raw_view_columns.map((col) => ({
				name: col.name,
				type_string: col.type,
				comment: "",
				is_nullable: col.notnull === 0,
				is_primary_key: col.pk > 0,
				is_auto_increment: false,
				is_generated: false,
			}));
			schema_objects.push({
				type: "view",
				name: view_name,
				comment: "",
				columns: view_columns,
				foreign_keys: [],
				has_view: false,
			});
		}

		return schema_objects;
	}
}
