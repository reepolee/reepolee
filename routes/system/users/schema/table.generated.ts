// This file is auto-generated. Do not modify manually.
import type { FormFieldDef } from "$generator/schema/types";

export type users_type = {
	id?: number;
	email?: string;
	name?: string | null | undefined;
	nickname?: string | null | undefined;
	username?: string;
	avatar_filename?: string | null | undefined;
	verified_at?: string | null | undefined;
	hashed_password?: string | null | undefined;
	invitation_code?: string | null | undefined;
	modules_tags?: string | null | undefined;
	previous_hashed_password?: string | null | undefined;
	created_at?: string | null | undefined;
	updated_at?: string | null | undefined;
};

export const fields: Record<string, FormFieldDef> = {
	"email": {
		"name": "email",
		"type": "text",
		"required": true,
		"is_nullable": false,
		"max": 255,
		"attributes": {
			"column_type": "varchar(255)",
			"domain_type": "email",
			"domain_compliant": true,
			"initial_width": "80ch",
			"initial_class": "",
		},
	},
	"name": {
		"name": "name",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"max": 80,
		"attributes": {
			"column_type": "varchar(80)",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "80ch",
			"initial_class": "",
		},
	},
	"nickname": {
		"name": "nickname",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"max": 20,
		"attributes": {
			"column_type": "varchar(20)",
			"domain_type": "username",
			"domain_compliant": true,
			"initial_width": "20ch",
			"initial_class": "",
		},
	},
	"username": {
		"name": "username",
		"type": "text",
		"required": true,
		"is_nullable": false,
		"max": 20,
		"attributes": {
			"column_type": "varchar(20)",
			"domain_type": "username",
			"domain_compliant": true,
			"initial_width": "20ch",
			"initial_class": "",
		},
	},
	"avatar_filename": {
		"name": "avatar_filename",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"max": 250,
		"attributes": {
			"column_type": "varchar(250)",
			"domain_type": null,
			"domain_compliant": false,
			"initial_width": "80ch",
			"initial_class": "",
		},
	},
	"verified_at": {
		"name": "verified_at",
		"type": "timestamp",
		"required": false,
		"is_nullable": true,
		"attributes": {
			"column_type": "timestamp",
			"domain_type": "timestamp",
			"domain_compliant": true,
			"initial_width": "20ch",
			"initial_class": "",
		},
	},
	"hashed_password": {
		"name": "hashed_password",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"max": 255,
		"attributes": {
			"column_type": "varchar(255)",
			"domain_type": "full_name",
			"domain_compliant": true,
			"initial_width": "80ch",
			"initial_class": "",
		},
	},
	"invitation_code": {
		"name": "invitation_code",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"max": 64,
		"attributes": {
			"column_type": "varchar(64)",
			"domain_type": "code_long",
			"domain_compliant": true,
			"initial_width": "64ch",
			"initial_class": "",
		},
	},
	"modules_tags": {
		"name": "modules_tags",
		"type": "tags",
		"required": false,
		"is_nullable": true,
		"attributes": {
			"column_type": "text",
			"tags": { "table": "modules" },
			"domain_type": "text_block",
			"domain_compliant": true,
			"initial_width": "auto",
			"initial_class": "",
		},
	},
	"previous_hashed_password": {
		"name": "previous_hashed_password",
		"type": "text",
		"required": false,
		"is_nullable": true,
		"max": 255,
		"attributes": {
			"column_type": "varchar(255)",
			"domain_type": "full_name",
			"domain_compliant": true,
			"initial_width": "80ch",
			"initial_class": "",
		},
	},
};
export const indexed_columns: string[] = ["id", "email", "username"];

export const v_fields: Record<string, FormFieldDef> | null = null;
