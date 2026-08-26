export type MetadataRecord = Record<string, unknown>;
export type MetadataFilter = { clause: string; params: any[] };

export function search_metadata<T extends object>(
	records: T[],
	search: string,
	offset: number,
	limit: number,
	order_by: string,
	search_fields: (keyof T)[],
	filter_clauses: MetadataFilter[] = [],
): { records: T[]; total: number } {
	const [requested_field = "", requested_direction] = order_by.split("::");
	const sort_field = Object.prototype.hasOwnProperty.call(records[0] ?? {}, requested_field) ? requested_field as keyof T : "id" as keyof T;
	const direction = requested_direction?.toLowerCase() === "desc" ? -1 : 1;
	const needle = search.trim().toLowerCase();
	const filtered = records.filter((record) => {
		if (needle && !search_fields.some((field) => String(record[field] ?? "").toLowerCase().includes(needle))) return false;
		return filter_clauses.every((filter) => evaluate_filter(record as MetadataRecord, filter));
	});
	filtered.sort((left, right) => compare_values((left as MetadataRecord)[sort_field as string], (right as MetadataRecord)[sort_field as string]) * direction);
	return { records: filtered.slice(offset, offset + limit), total: filtered.length };
}

function compare_values(left: unknown, right: unknown): number {
	if (typeof left === "number" && typeof right === "number") return left - right;
	return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
}

function evaluate_filter(record: MetadataRecord, filter: MetadataFilter): boolean {
	const match = filter.clause.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|LIKE|NOT LIKE|IN|NOT IN)\s*\(([^)]*)\)|^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|LIKE|NOT LIKE)\s*\?/i);
	if (!match) return true;
	const field = match[1] ?? match[4];
	const operator = (match[2] ?? match[5] ?? "=").toUpperCase();
	const value = record[field!];
	const params = filter.params.map(String);
	if (operator === "IN" || operator === "NOT IN") return (params.includes(String(value)) ? operator === "IN" : operator === "NOT IN");
	const expected = params[0] ?? "";
	const actual = String(value ?? "");
	const equal = actual === expected;
	const like = actual.toLowerCase().includes(expected.replaceAll("%", "").toLowerCase());
	return operator === "=" ? equal : operator === "!=" ? !equal : operator === "LIKE" ? like : !like;
}
