import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

export const schema = z.object({
	id: z.coerce.number().optional(),
	code: z.string().min(1, "code_required").max(15, "code_max"),
	name: z.string().min(1, "name_required").max(30, "name_max"),
	description: z.string().min(1, "description_required").max(100, "description_max"),
});

export const validate = (data: any, messages?: Record<string, string>) => { return validate_schema(schema, data, undefined, messages); };

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => { return validate_schema(schema, data, touched, messages); };
