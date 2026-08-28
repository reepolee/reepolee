export interface ColumnDef {
	name: string;
	type_string: string;
	comment: string;
	is_nullable: boolean;
	is_primary_key: boolean;
	is_auto_increment: boolean;
	is_unique?: boolean;
	is_generated?: boolean;
}

// Closed set of field-rendering kinds. Persisted as FormFieldDef.type / FieldDef.type -
// determines both the Zod validation branch (validation_generator.ts) and the
// fields/<kind>.ree / components/input-<kind>.ree template picked for rendering
// (crud/form_ree.ts). Resolved once, fully, in field_generator.ts::generate_fields_object().
export type FieldKind =
	| "text"
	| "textarea"
	| "number"
	| "checkbox"
	| "date"
	| "datetime"
	| "timestamp"
	| "time"
	| "markdown"
	| "select"
	| "foreign_key"
	| "yes_no"
	| "tags"
	| "image"
	| "file"
	| "autocomplete";

export interface ForeignKeyDef {
	constraint_name: string;
	column_name: string;
	referenced_table_name: string;
	referenced_column_name: string;
}

export interface ParentInfo {
	table: string;
	fk_column: string;
	route_param: string;
	label: string;
}

/**
 * A table's primary key, captured separately from `columns` because the
 * SQLite introspector drops PK columns from `columns` (matching MySQL, where
 * `generate_fields_object` filters them out downstream). This is the one
 * place the auto-increment-ness of the key survives, and it gates whether a
 * table is eligible for per-locale content (clone rows reuse the base row's
 * integer id verbatim, so only an integer auto-increment key qualifies).
 */
export interface PrimaryKeyInfo {
	name: string;
	type_string: string;
	/** True only for a single integer auto-increment key (SQLite's `INTEGER
	 * PRIMARY KEY` rowid alias, or MySQL AUTO_INCREMENT). */
	is_auto_increment: boolean;
}

export interface SchemaObject {
	type: "table" | "view";
	name: string;
	comment?: string;
	columns: ColumnDef[];
	view_columns?: ColumnDef[];
	foreign_keys: ForeignKeyDef[];
	/** Column names that participate in UNIQUE/PRIMARY indexes (including composite indexes). */
	unique_columns?: string[];
	has_view: boolean;
	parent?: ParentInfo;
	primary_key?: PrimaryKeyInfo;
}

/**
 * A schema supplied by a developer for a resource backed by something other
 * than a database table, such as a config file, filesystem, or external API.
 */
export interface SyntheticSchema extends SchemaObject {
	type: "table";
	foreign_keys: [];
	has_view: false;
}

export interface ColumnAttributes {
	label?: string;
	type?: FieldKind;
	min?: string | number;
	max?: string | number;
	omit?: boolean;
	filter?: boolean;
	foreign_key?: { table: string; column: string; };
	[key: string]: any;
}

export interface FormFieldDef {
	name: string;
	type: FieldKind;
	required: boolean;
	is_nullable: boolean;
	min?: string | number;
	max?: string | number;
	attributes?: ColumnAttributes;
}

export interface GridColumnDefinition {
	name: string;
	width: string;
	class_name: string;
	filter: boolean;
	/**
	 * Optional built-in template helper applied to this column's index-grid
	 * cell, e.g. "js_date_to_locale_string" renders the value via
	 * `{~ js_date_to_locale_string(record.field) }`. Empty means the default
	 * type-based cell rendering.
	 */
	helper?: string;
	/** Display this column's value on forms without an editor (never editable). */
	readonly?: boolean;
}
