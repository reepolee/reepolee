import { validate_schema, z_datetime_optional } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

// z.compile() pre-compiles the schema once at module load so every
// subsequent parse is several times faster (Zod 4.5+). Compiled schemas are
// drop-in: .safeParse(), .shape, and per-field access all keep working.
export const schema = z.compile(z.object({
	id: z.coerce.number().optional(),
	email: z.string().min(1, "email_required"),
	name: z.nullable(z.string()),
	nickname: z.nullable(z.string()),
	username: z.string().min(1, "required"),
	avatar_filename: z.nullable(z.string()),
	verified_at: z_datetime_optional,
	hashed_password: z.nullable(z.string()),
	invitation_code: z.nullable(z.string()),
	modules_tags: z.nullable(z.string()),
	previous_hashed_password: z.nullable(z.string()),
}));

export const validate = (data: any, messages?: Record<string, string>) => { return validate_schema(schema, data, undefined, messages); };

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => { return validate_schema(schema, data, touched, messages); };
