import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

export const schema = z.object({
	name: z.string().min(1, "name_required").max(80, "name_too_long"),
	nickname: z.string().max(20, "nickname_too_long").optional().default(""),
});

export const validate = (data: any, messages?: Record<string, string>) => validate_schema(schema, data, undefined, messages);

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => validate_schema(schema, data, touched, messages);
