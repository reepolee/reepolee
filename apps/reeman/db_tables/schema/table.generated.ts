// This file is auto-generated. Do not modify manually.
import { type FormFieldDef } from "$generator/schema/types";

export type db_tables_type = {
	name?: string;
	column_count?: number;
	fk_count?: number;
	has_crud?: number;
	display?: string | null | undefined;
	created_at?: string;
	updated_at?: string | null | undefined;
};

export const fields: Record<string, FormFieldDef> = {
	"name": {
		"name": "name",
		"type": "text",
		"required": true,
		"is_nullable": false,
		"attributes": {
			"column_type": "TEXT",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "auto",
			"initial_class": "",
		},
	},
	"column_count": {
		"name": "column_count",
		"type": "number",
		"required": true,
		"is_nullable": false,
		"attributes": {
			"column_type": "INTEGER",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "10ch",
			"initial_class": "",
		},
	},
	"fk_count": {
		"name": "fk_count",
		"type": "number",
		"required": true,
		"is_nullable": false,
		"attributes": {
			"column_type": "INTEGER",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "10ch",
			"initial_class": "",
		},
	},
	"has_crud": {
		"name": "has_crud",
		"type": "yes_no",
		"required": true,
		"is_nullable": false,
		"attributes": {
			"column_type": "INTEGER",
			"domain_type": "boolean",
			"domain_compliant": true,
			"initial_width": "15ch",
			"initial_class": "text-center",
		},
	},
	"display": {
		"name": "display",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"attributes": {
			"column_type": "TEXT",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "auto",
			"initial_class": "",
		},
	},
};
export const indexed_columns: string[] = ["name"];

export const v_fields: Record<string, FormFieldDef> | null = null;
