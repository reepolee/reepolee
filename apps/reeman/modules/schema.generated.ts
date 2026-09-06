// This file is auto-generated. Do not modify manually.
import type { FormFieldDef } from "$generator/schema/types";

export type modules_type = {
	id?: number;
	code?: string;
	name?: string;
	description?: string;
	created_at?: string;
	updated_at?: string;
};

export const fields: Record<string, FormFieldDef> = {
	code: {
		name: "code",
		type: "text",
		required: true,
		is_nullable: false,
		max: 15,
		attributes: {
			column_type: "varchar(15)",
			domain_type: null,
			domain_compliant: false,
			initial_width: "15ch",
			initial_class: "",
		},
	},
	name: {
		name: "name",
		type: "text",
		required: true,
		is_nullable: false,
		max: 30,
		attributes: {
			column_type: "varchar(30)",
			domain_type: "street_extra",
			domain_compliant: true,
			initial_width: "30ch",
			initial_class: "",
		},
	},
	description: {
		name: "description",
		type: "text",
		required: true,
		is_nullable: false,
		max: 100,
		attributes: {
			column_type: "varchar(100)",
			domain_type: "first_name",
			domain_compliant: true,
			initial_width: "80ch",
			initial_class: "",
		},
	},
};
export const indexed_columns: string[] = ["id", "code"];

export const v_fields: Record<string, FormFieldDef> | null = null;
