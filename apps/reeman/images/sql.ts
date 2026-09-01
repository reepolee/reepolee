import { db } from "$config/db";
import { archive_clause, archive_counts_query, to_archive_counts, type ArchiveCounts, type ArchiveFilter } from "$lib/archive";

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
	archived_at?: string | null;
	archived_by_user_id?: number | null;
}

export interface Options {
	option_value: number;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		const records = await db`SELECT * FROM images WHERE archived_at IS NULL ORDER BY id ASC`;

		return records as Record[];
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_images_select_options(): Promise<Options[]> {
	try {
		const records = await db`SELECT id as option_value, folder as option_text FROM images WHERE archived_at IS NULL ORDER BY folder ASC`;
		return records as Options[];
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_record_by_id(id: number, include_archived: boolean = false): Promise<Record | undefined> {
	try {
		const archive_where = include_archived ? "" : " AND archived_at IS NULL";
		const by_id_query = `SELECT * FROM images WHERE id = ?${archive_where} LIMIT 1`;
		const records = (await db.unsafe(by_id_query, [id])) as Record[];
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
	archive_filter: ArchiveFilter = "live",
): Promise<{ records: Record[]; total: number; }> {
	try {
		let records: Record[] = [];
		let total: number = 0;

		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, offset, limit, "id::asc", scope_clause, filter_clauses, archive_filter);
		}

		const where_clauses: string[] = [];
		const params: any[] = [];

		const list_archive_where = archive_clause(archive_filter);
		if (list_archive_where) { where_clauses.push(list_archive_where); }

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

export async function archive_record(id: number, archived_by_user_id: number | null): Promise<boolean> {
	try {
		const result = await db`UPDATE images SET archived_at = CURRENT_TIMESTAMP, archived_by_user_id = ${archived_by_user_id} WHERE id = ${id} AND archived_at IS NULL`;
		return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
	} catch (error) {
		console.error("Error archiving record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) { throw error; }
		return false;
	}
}

export async function restore_record(id: number): Promise<boolean> {
	try {
		const result = await db`UPDATE images SET archived_at = NULL, archived_by_user_id = NULL WHERE id = ${id} AND archived_at IS NOT NULL`;
		return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
	} catch (error) {
		console.error("Error restoring record:", error);
		return false;
	}
}

export async function get_archive_counts(scope_clause: string = ""): Promise<ArchiveCounts> {
	try {
		const counts_query = archive_counts_query("images", scope_clause);
		const counts_result = await db.unsafe(counts_query, []);
		return to_archive_counts(counts_result[0]);
	} catch (error) {
		console.error("Error fetching archive counts:", error);
		return { total: 0, live: 0, archived: 0 };
	}
}
