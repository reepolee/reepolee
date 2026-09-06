// This file is auto-generated. Do not modify manually.
import type { FormFieldDef } from "$generator/schema/types";

export type global_scopes_type = {
	id?: number;
	module_code?: string;
	table_name?: string;
	scope_key?: string;
	display_name?: string;
	where_clause?: string;
	sort_order?: number;
	is_default?: number;
	created_at?: string;
	updated_at?: string | null | undefined;
};

export const fields: Record<string, FormFieldDef> = {
	module_code: {
		name: "module_code",
		type: "text",
		required: true,
		is_nullable: false,
		max: 15,
		attributes: { column_type: "varchar(15)" },
	},
	feature_name: {
		name: "feature_name",
		type: "text",
		required: true,
		is_nullable: false,
		max: 64,
		attributes: { column_type: "varchar(64)" },
	},
	table_name: {
		name: "table_name",
		type: "text",
		required: true,
		is_nullable: false,
		max: 64,
		attributes: { column_type: "varchar(64)" },
	},
	scope_key: {
		name: "scope_key",
		type: "text",
		required: true,
		is_nullable: false,
		max: 64,
		attributes: { column_type: "varchar(64)" },
	},
	display_name: {
		name: "display_name",
		type: "text",
		required: true,
		is_nullable: false,
		max: 100,
		attributes: { column_type: "varchar(100)" },
	},
	where_clause: {
		name: "where_clause",
		type: "text",
		required: true,
		is_nullable: false,
		attributes: { column_type: "text" },
	},
	sort_order: {
		name: "sort_order",
		type: "number",
		required: true,
		is_nullable: false,
		attributes: { column_type: "int(10) unsigned" },
	},
	is_default: {
		name: "is_default",
		type: "number",
		required: true,
		is_nullable: false,
		attributes: { column_type: "tinyint(1)" },
	},
};
export const indexed_columns: string[] = ["id", "table_name", "scope_key"];

export const v_fields: Record<string, FormFieldDef> | null = null;
