import type { TypeMapper } from "../type_mapper";

export class SQLiteTypeMapper implements TypeMapper {
	to_html_input(column_type: string): string {
		const lower = column_type.toLowerCase();
		if (lower.includes("int")) return "number";
		if (lower.includes("real") || lower.includes("float") || lower.includes("double")) return "number";
		if (lower.includes("bool")) return "checkbox";
		if (lower.includes("date") && !lower.includes("time")) return "date";
		if (lower.includes("datetime") && !lower.includes("timestamp")) return "datetime";
		if (lower.includes("timestamp")) return "timestamp";
		if (lower.includes("time")) return "time";
		if (lower.includes("text") && lower.length > 20) return "textarea";
		return "text";
	}

	to_typescript(column_type: string): string {
		const lower = column_type.toLowerCase();
		if (lower.includes("int")) return "number";
		if (lower.includes("real") || lower.includes("float") || lower.includes("double")) return "number";
		if (lower.includes("bool")) return "boolean";
		return "string";
	}
}
