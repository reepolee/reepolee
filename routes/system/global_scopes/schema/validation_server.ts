import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

export const schema = z.object({
	id: z.coerce.number().optional(),
	module_code: z.string().max(15, "module_code_max"),
	table_name: z.string().min(1, "table_name_required").max(64, "table_name_max"),
	scope_key: z.string().min(1, "scope_key_required").max(64, "scope_key_max"),
	display_name: z.string().min(1, "display_name_required").max(100, "display_name_max"),
	where_clause: z.string().min(1, "where_clause_required"),
	sort_order: z.coerce.number(),
	is_default: z.coerce.number().min(0, "is_default_required"),
});

export const validate = (data: any, messages?: Record<string, string>) => { return validate_schema(schema, data, undefined, messages); };

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => { return validate_schema(schema, data, touched, messages); };
