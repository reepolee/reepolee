import { MIN_PASSWORD_LENGTH } from "$config/db_structure";
import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

export const schema = z.object({
	current_password: z.string().min(1, "current_password_required"),
	password: z.string().min(MIN_PASSWORD_LENGTH, "password_too_short"),
	password_confirm: z.string().min(1, "password_confirm_required"),
}).refine((data) => data.password === data.password_confirm, {
	message: "passwords_mismatch",
	path: ["password_confirm"],
});

export const validate = (data: any, messages?: Record<string, string>) => validate_schema(schema, data, undefined, messages);

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => validate_schema(schema, data, touched, messages);
