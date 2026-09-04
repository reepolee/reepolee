import { MIN_PASSWORD_LENGTH } from "$config/db_structure";
import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

// z.compile() pre-compiles the schema once at module load so every
// subsequent parse is several times faster (Zod 4.5+). Compiled schemas are
// drop-in: .safeParse(), .shape, and per-field access all keep working.
export const schema = z.compile(z.object({
	current_password: z.string().min(1, "current_password_required"),
	password: z.string().min(MIN_PASSWORD_LENGTH, "password_too_short"),
	password_confirm: z.string().min(1, "password_confirm_required"),
}).refine((data) => data.password === data.password_confirm, {
	message: "passwords_mismatch",
	path: ["password_confirm"],
}));

export const validate = (data: any, messages?: Record<string, string>) => validate_schema(schema, data, undefined, messages);

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => validate_schema(schema, data, touched, messages);
