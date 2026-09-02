import { z } from "$vendor/zod.min.js";
import {
	validate_schema,
	z_date_required,
	z_date_optional,
	z_datetime_required,
	z_datetime_optional,
} from "$lib/validation_helpers";

// z.compile() pre-compiles the schema once at module load so every
// subsequent parse is several times faster (Zod 4.5+). Compiled schemas are
// drop-in: .safeParse(), .shape, and per-field access all keep working.
export const schema = z.compile(z.object({
	id: z.coerce.number().optional(),
	url: z.string().min(1, "url_required"),
	table_name: z.string().min(1, "table_name_required"),
	module: z.string().min(1, "module_required"),
	removable: z.coerce.number(),
}));

export const validate = (data: any, messages?: Record<string, string>) => {
	return validate_schema(schema, data, undefined, messages);
};

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => {
	return validate_schema(schema, data, touched, messages);
};
