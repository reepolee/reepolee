import { validate_schema } from "$lib/validation_helpers";
import { z } from "$vendor/zod.min.js";

// z.compile() pre-compiles the schema once at module load so every
// subsequent parse is several times faster (Zod 4.5+). Compiled schemas are
// drop-in: .safeParse(), .shape, and per-field access all keep working.
export const schema = z.compile(z.object({
	name: z.string().min(1, "name_required").max(80, "name_too_long"),
	nickname: z.string().max(20, "nickname_too_long").optional().default(""),
}));

export const validate = (data: any, messages?: Record<string, string>) => validate_schema(schema, data, undefined, messages);

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => validate_schema(schema, data, touched, messages);
