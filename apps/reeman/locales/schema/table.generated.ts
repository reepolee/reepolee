// Hand-maintained field metadata for the locales "fake table" (mirrors the
// generated db_tables fields shape). Drives get_filter_definitions() for the
// ree-filters component - the /locales page itself is a custom grid.
import { type FormFieldDef } from "$generator/schema/types";

export type locales_type = {
	code?: string;
	name?: string;
	alias?: string;
	active?: number;
	default?: number;
};

export const fields: Record<string, FormFieldDef> = {
	"code": {
		"name": "code",
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
	"alias": {
		"name": "alias",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"attributes": {
			"column_type": "TEXT",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "15ch",
			"initial_class": "",
		},
	},
	"active": {
		"name": "active",
		"type": "yes_no",
		"required": false,
		"is_nullable": false,
		"attributes": {
			"column_type": "INTEGER",
			"domain_type": "boolean",
			"domain_compliant": true,
			"initial_width": "12ch",
			"initial_class": "text-center",
		},
	},
	"default": {
		"name": "default",
		"type": "yes_no",
		"required": false,
		"is_nullable": false,
		"attributes": {
			"column_type": "INTEGER",
			"domain_type": "boolean",
			"domain_compliant": true,
			"initial_width": "12ch",
			"initial_class": "text-center",
		},
	},
};

export const indexed_columns: string[] = ["code"];

export const v_fields: Record<string, FormFieldDef> | null = null;
