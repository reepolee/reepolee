import { z } from "$vendor/zod.min.js";
import {
	validate_schema,
	z_date_required,
	z_date_optional,
	z_datetime_required,
	z_datetime_optional,
} from "$lib/validation_helpers";

export const schema = z.object({
	id: z.coerce.number().optional(),
	name: z.string().min(1, "name_required"),
	column_count: z.coerce.number(),
	fk_count: z.coerce.number(),
	has_crud: z.coerce.number().min(0, "has_crud_required"),
});

export const validate = (data: any, messages?: Record<string, string>) => {
	return validate_schema(schema, data, undefined, messages);
};

export const validate_touched = (data: any, touched: string[], messages?: Record<string, string>) => {
	return validate_schema(schema, data, touched, messages);
};
