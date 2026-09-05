import type { FieldKind } from "../schema/types";

export interface FieldDef {
	name: string;
	type: FieldKind;
	label?: string;
	required?: boolean;
	is_nullable?: boolean;
	min?: string | number;
	max?: string | number;
	attributes?: {
		foreign_key?: { table: string; column: string; };
		tags?: { table: string; };
		filter?: boolean;
		column_type?: string;
		rows?: number;
		omit?: boolean;
		omit_index?: boolean;
		options?: any[];
		fk_type?: string;
		[key: string]: unknown;
	};
}

// Grid/display config for a config.ts column entry, as written by write_table.ts.
export interface ColumnDef {
	width: string;
	class: string;
	domain?: string;
	filter?: boolean;
	/**
	 * Built-in template helper applied to this column's index-grid cell, e.g.
	 * "js_date_to_locale_string". Empty/absent means the default type-based
	 * cell rendering.
	 */
	helper?: string;
	grid?: boolean;
	localized?: boolean;
	/** Display this column's value on forms without an editor (never editable). */
	readonly?: boolean;
	/** Include this column as an editable field on generated forms. */
	form?: boolean;
}

export interface ParentInfo {
	table: string;
	fk_column: string;
	route_param: string;
	label?: string;
}

export type PaginationStrategy = "cursor" | "offset";
export type RenderStrategy = "stream" | "load";

/**
 * A field the CRUD editor can translate per locale. Which fields are
 * localizable is schema structure and so is baked at generation time; WHICH
 * LOCALES exist is config and is resolved per request.
 *
 * No value_column: each locale's value lives in a real typed column on that
 * locale's own table, so there is no typed-column-of-an-EAV-row to pick.
 */
export interface LocalizedFieldMeta {
	field_name: string;
	label: string;
	input_type: string;
	upload_folder?: string;
}

// Foreign keys of a table, keyed by column name.
export type ForeignKeyMap = Map<string, { table: string; column: string; label?: string; localized?: boolean; }>;
