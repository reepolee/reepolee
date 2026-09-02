import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

// z.compile() pre-compiles the schema once at module load so every
// subsequent parse is several times faster (Zod 4.5+). Compiled schemas are
// drop-in: .safeParse(), .shape, and per-field access all keep working.
export const schema = z.compile(z.object({
	id: z.coerce.number().optional(),
	folder: z.nullable(z.string().optional()),
	filename: z.string().min(1, "filename_required"),
	s3_key: z.string().min(1, "s3_key_required"),
	original_filename: z.nullable(z.string().optional()),
	title: z.nullable(z.string().optional()),
	description: z.nullable(z.string().optional()),
	tags: z.nullable(z.string().optional()),
	mime_type: z.nullable(z.string().optional()),
	file_type: z.nullable(z.string().optional()),
	file_size: z.nullable(z.coerce.number().optional()),
}));

export const validate = (data: any, messages?: Record<string, string>) => { return validate_schema(schema, data, undefined, messages); };

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => { return validate_schema(schema, data, touched, messages); };
