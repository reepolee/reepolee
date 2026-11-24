/**
 * Studio - typed model for SQL DDL files.
 *
 * A .sql file is kept as an ordered list of statements. Every statement
 * carries the exact text that preceded it (`gap`: blank lines and `--` comments),
 * so an unedited file serializes back byte-identically. Only `create_table`
 * statements are parsed into typed columns; everything else rides along verbatim.
 */

export type Dialect = "sqlite" | "mysql";

export type Nullability = "not_null" | "null" | "unspecified";

export type ModifierKey =
	| "nullability"
	| "primary_key"
	| "auto_increment"
	| "default"
	| "unique"
	| "generated"
	| "on_update"
	| "references"
	| "comment";

export interface ColumnReference {
	table: string;
	column: string;
	on_update?: string;
	on_delete?: string;
} export interface StudioColumn {
	name: string;
	/** Verbatim type text, e.g. "INTEGER", "VARCHAR(30)", "INT UNSIGNED", "DECIMAL(10, 2)". */
	type_string: string;
	/** Domain type key, e.g. "first_name", "image", "timestamp". Set from embedded Studio metadata or palette; null when unknown. */
	domain_type?: string | null;
	nullability: Nullability;
	/** Verbatim default token: "''", "NULL", "CURRENT_TIMESTAMP", "1". null = no DEFAULT clause. */
	default_value: string | null;
	is_primary_key: boolean;
	is_auto_increment: boolean;
	is_unique: boolean;
	is_generated: boolean;
	/** Verbatim expression inside GENERATED ALWAYS AS (...), without outer parens. */
	generated_expr?: string;
	/** Original whitespace between AS and "(" so dirty regeneration stays lossless. */
	generated_as_pad?: string;
	generated_kind?: "VIRTUAL" | "STORED";
	on_update_current_timestamp: boolean;
	/** Inline REFERENCES clause (sqlite 05-frameworks style). */
	references?: ColumnReference;
	/** MySQL COMMENT '...' text (unquoted value). */
	comment?: string;
	/** Original modifier order, so regeneration reproduces the column byte-for-byte. */
	modifier_order: ModifierKey[];
	/** Modifier text the parser did not understand - emitted verbatim at the end. */
	extra_raw?: string;
	/** Exact whitespace between name and type, captured at parse time (keeps hand alignment). */
	name_pad?: string;
	/** Exact whitespace between type and the first modifier, captured at parse time. */
	type_pad?: string;
}

export interface TableForeignKey {
	/** MySQL CONSTRAINT <name> prefix, when present. */
	constraint_name?: string;
	column: string;
	ref_table: string;
	ref_column: string;
	on_update?: string;
	on_delete?: string;
	/** Verbatim ON UPDATE/ON DELETE text after the REFERENCES, so regeneration keeps the original clause order. */
	actions_raw?: string;
}

/** A table-level UNIQUE constraint, including MySQL's named UNIQUE KEY form. */
export interface TableUniqueKey {
	/** SQL-standard CONSTRAINT <name> UNIQUE(...) prefix. */
	constraint_name?: string;
	/** MySQL UNIQUE KEY <name>(...) name. */
	key_name?: string;
	columns: string[];
	/** Verbatim comma-separated text inside the parens, so regeneration keeps original spacing. */
	columns_raw?: string;
}

export interface StudioIndex {
	name: string;
	columns: string[];
	unique: boolean;
}

export interface StudioTable {
	name: string;
	/** Verbatim identifier as written (quotes, schema qualifier), when it differs from `name`. */
	name_raw?: string;
	/** Verbatim clause between CREATE and the identifier, e.g. "TABLE IF NOT EXISTS " or "TEMP TABLE ". */
	create_prefix_raw?: string;
	/** Body lines the parser did not understand (e.g. table-level PRIMARY KEY(...)) - re-emitted verbatim so regeneration is lossless. */
	extra_lines_raw?: string[];
	columns: StudioColumn[];
	table_foreign_keys: TableForeignKey[];
	table_unique_keys: TableUniqueKey[];
	/** Verbatim text after the closing paren, e.g. MySQL "COMMENT ''". */
	table_suffix_raw: string;
}

export type StatementKind =
	| "drop_table"
	| "drop_view"
	| "create_table"
	| "index"
	| "trigger"
	| "insert"
	| "create_view"
	| "raw";

export interface StudioStatement {
	/** Exact text between the previous statement's ";" and this statement (whitespace + comments). */
	gap: string;
	kind: StatementKind;
	/** Table/view/index/trigger name ("" for raw). */
	object_name: string;
	/** Owning table for index/trigger/insert statements. */
	parent_table?: string;
	/** Full statement text including the trailing ";". */
	text: string;
	/** Parsed columns, only for kind === "create_table". */
	table?: StudioTable;
	/** Set client-side when the table was edited and must be regenerated on save. */
	dirty?: boolean;
	/** Set client-side for tables added in the editor (no statements exist yet). */
	is_new?: boolean;
}

export interface StudioFile {
	/** Path relative to the repo root, e.g. "sql/sqlite/demos/05-frameworks.sql". */
	path: string;
	dialect: Dialect;
	statements: StudioStatement[];
	/** Exact text after the last statement's ";" (usually a single newline). */
	trailing: string;
}

/** Sidebar/API view of a file: groups statements into editable objects. */
export interface StudioObjectList {
	tables: { name: string; statement_index: number; }[];
	views: { name: string; statement_index: number; }[];
}
