import { db } from "$config/db";

// db.unsafe() - legacy manual CRUD. Uses dynamic ORDER BY via sort_field regex validation.
// Uses offset-based pagination (not cursor-based). Migrate to generator template when regenerating.

export interface Record {
	id: number;
	folder: string;
	filename: string;
	s3_key: string;
	original_filename: string;
	title: string;
	description: string;
	tags: string;
	mime_type: string;
	width: number;
	height: number;
	file_size: number;
}

export interface Options {
	option_value: number;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		const records = await db`SELECT * FROM images ORDER BY id ASC`;

		return records as Record[];
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_images_select_options(): Promise<Options[]> {
	try {
		const records = await db`SELECT id as option_value, folder as option_text FROM images ORDER BY folder ASC`;
		return records as Options[];
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_record_by_id(id: number): Promise<Record | undefined> {
	try {
		const records = await db`SELECT * FROM images WHERE id = ${id} LIMIT 1`;
		const record = records[0];
		return record as Record | undefined;
	} catch (error) {
		console.error("Error fetching record by id:", error);
		return undefined;
	}
}

export async function search_records(
	search: string = "",
	offset: number = 0,
	limit: number = 20,
	order_by: string = "id::asc",
	scope_clause: string = "",
	filter_clauses: { clause: string; params: any[]; }[] = [],
): Promise<{ records: Record[]; total: number; }> {
	try {
		let records: Record[] = [];
		let total: number = 0;

		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, offset, limit, "id::asc", scope_clause, filter_clauses);
		}

		const where_clauses: string[] = [];
		const params: any[] = [];

		if (search) {
			const search_term = `%${search}%`;
			where_clauses.push("(folder LIKE ? OR title LIKE ? OR description LIKE ? OR tags LIKE ?)");
			params.push(search_term, search_term, search_term, search_term);
		}

		if (scope_clause) { where_clauses.push(`(${scope_clause})`); }

		for (const filter of filter_clauses) {
			where_clauses.push(`(${filter.clause})`);
			params.push(...filter.params);
		}

		const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(" AND ")}` : "";
		const query = `SELECT * FROM v_images ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
		records = await db.unsafe(query, [...params, limit, offset]);

		const count_query = `SELECT COUNT(*) as count FROM v_images ${where}`;
		const count_result = await db.unsafe(count_query, params);
		total = (count_result[0] as any)?.count || 0;

		return { records: records as Record[], total };
	} catch (error) {
		console.error("Error searching records:", error);
		return { records: [], total: 0 };
	}
}

export async function create_record(record: Omit<Record, "id">): Promise<Record> {
	try {
		const insert_result = await db`INSERT INTO images (folder, filename, s3_key, original_filename, title, description, tags, mime_type, width, height, file_size) VALUES (${record.folder}, ${record.filename}, ${record.s3_key}, ${record.original_filename}, ${record.title}, ${record.description}, ${record.tags}, ${record.mime_type}, ${record.width}, ${record.height}, ${record.file_size})`;
		const get_result = await db`SELECT * FROM images WHERE id = ${insert_result.lastInsertRowid} LIMIT 1`;
		return get_result[0] as Record;
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: number, record: Omit<Record, "id">): Promise<Record | undefined> {
	try {
		await db`UPDATE images SET folder = ${record.folder}, filename = ${record.filename}, s3_key = ${record.s3_key}, original_filename = ${record.original_filename}, title = ${record.title}, description = ${record.description}, tags = ${record.tags}, mime_type = ${record.mime_type}, width = ${record.width}, height = ${record.height}, file_size = ${record.file_size} WHERE id = ${id}`;
		const records = await db`SELECT * FROM images WHERE id = ${id} LIMIT 1`;
		return records[0] as Record | undefined;
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function delete_record(id: number): Promise<boolean> {
	try {
		const result = await db`DELETE FROM images WHERE id = ${id}`;
		return (result.affectedRows ?? result.changes ?? 0) > 0;
	} catch (error) {
		console.error("Error deleting record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) { throw error; }
		return false;
	}
}
