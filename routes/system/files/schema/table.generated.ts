// This file is auto-generated. Do not modify manually.
import type { FormFieldDef } from "$generator/schema/types";

export type files_type = {
	id?: number;
	folder?: string | null | undefined;
	filename?: string;
	s3_key?: string;
	original_filename?: string | null | undefined;
	title?: string | null | undefined;
	description?: string | null | undefined;
	tags?: string | null | undefined;
	mime_type?: string | null | undefined;
	file_type?: string | null | undefined;
	file_size?: number | null | undefined;
	created_at?: string | null | undefined;
	updated_at?: string | null | undefined;
};

export const fields: Record<string, FormFieldDef> = {
	folder: { name: "folder", type: "text", required: false, is_nullable: true, attributes: {} },
	filename: { name: "filename", type: "text", required: true, is_nullable: false, attributes: {} },
	s3_key: { name: "s3_key", type: "text", required: true, is_nullable: false, attributes: {} },
	original_filename: {
		name: "original_filename",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	title: { name: "title", type: "text", required: false, is_nullable: true, attributes: {} },
	description: {
		name: "description",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	tags: { name: "tags", type: "text", required: false, is_nullable: true, attributes: {} },
	mime_type: { name: "mime_type", type: "text", required: false, is_nullable: true, attributes: {} },
	file_type: { name: "file_type", type: "text", required: false, is_nullable: true, attributes: {} },
	file_size: {
		name: "file_size",
		type: "number",
		required: false,
		is_nullable: true,
		attributes: {},
	},
};

export const v_fields: Record<string, FormFieldDef> = {
	folder: { name: "folder", type: "text", required: false, is_nullable: true, attributes: {} },
	filename: { name: "filename", type: "text", required: true, is_nullable: false, attributes: {} },
	s3_key: { name: "s3_key", type: "text", required: true, is_nullable: false, attributes: {} },
	original_filename: {
		name: "original_filename",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	title: { name: "title", type: "text", required: false, is_nullable: true, attributes: {} },
	description: {
		name: "description",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	tags: { name: "tags", type: "text", required: false, is_nullable: true, attributes: {} },
	mime_type: { name: "mime_type", type: "text", required: false, is_nullable: true, attributes: {} },
	file_type: { name: "file_type", type: "text", required: false, is_nullable: true, attributes: {} },
	file_size: {
		name: "file_size",
		type: "number",
		required: false,
		is_nullable: true,
		attributes: {},
	},
	search_text: {
		name: "search_text",
		type: "text",
		required: false,
		is_nullable: true,
		attributes: {},
	},
};
