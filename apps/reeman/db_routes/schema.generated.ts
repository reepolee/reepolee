// This file is auto-generated. Do not modify manually.
import { type FormFieldDef } from "$generator/schema/types";

export type db_routes_type = {
	url?: string;
	table_name?: string;
	module?: string;
	removable?: number;
	template_hash_status?: "clean" | "modified" | "untracked" | null;
	display?: string | null | undefined;
	created_at?: string;
	updated_at?: string | null | undefined;
};

export const fields: Record<string, FormFieldDef> = {
	"url": {
		"name": "url",
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
	"table_name": {
		"name": "table_name",
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
	"module": {
		"name": "module",
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
	"removable": {
		"name": "removable",
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
	"template_hash_status": {
		"name": "template_hash_status",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"attributes": {
			"column_type": "TEXT",
			"domain_type": null,
			"domain_compliant": false,
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
export const indexed_columns: string[] = ["url"];

export const v_fields: Record<string, FormFieldDef> | null = null;
