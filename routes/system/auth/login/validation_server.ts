import { MIN_PASSWORD_LENGTH } from "$config/db_structure";
import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

export const schema = z.object({
	username: z.string().min(1, "username_required"),
	password: z.string().min(MIN_PASSWORD_LENGTH, "password_too_short"),
});

export const validate = (data: any, messages?: Record<string, string>) => validate_schema(schema, data, undefined, messages);

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => validate_schema(schema, data, touched, messages);
