import { validate_schema, z_datetime_optional } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

export const schema = z.object({
	id: z.coerce.number().optional(),
	email: z.string().min(1, "email_required"),
	name: z.nullable(z.string().optional()),
	nickname: z.nullable(z.string().optional()),
	username: z.string().min(1, "required"),
	avatar_filename: z.nullable(z.string().optional()),
	verified_at: z.nullable(z_datetime_optional),
	hashed_password: z.nullable(z.string().optional()),
	invitation_code: z.nullable(z.string().optional()),
	modules_tags: z.nullable(z.string().optional()),
	previous_hashed_password: z.nullable(z.string().optional()),
});

export const validate = (data: any, messages?: Record<string, string>) => { return validate_schema(schema, data, undefined, messages); };

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => { return validate_schema(schema, data, touched, messages); };
