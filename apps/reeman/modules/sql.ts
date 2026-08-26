import { db } from "$config/db";
import { cache } from "$lib/cache";
import { timed_query } from "$lib/timed_sql";
import { archive_clause, archive_counts_query, to_archive_counts, type ArchiveCounts, type ArchiveFilter } from "$lib/archive";

export const TABLE_NAME = "modules";
export const VIEW_DEPENDENCIES = ["modules"];

export interface Record {
	id: number;
	code: string;
	name: string;
	description: string;
	archived_at?: string | null;
	archived_by_user_id?: number | null;
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		return await timed_query("modules", "get_all_records", async () => {
			const _records = await db`SELECT * FROM modules WHERE archived_at IS NULL ORDER BY id ASC`;
			const records = _records;

			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_modules_select_options(): Promise<Options[]> {
	try {
		return await timed_query("modules", "get_select_options", async () => {
			const records = await db`SELECT id as option_value, code as option_text FROM modules WHERE archived_at IS NULL ORDER BY code ASC LIMIT 50`;
			return records as Options[];
		});
	} catch (error) {
		console.error("Error fetching select options:", error);
		return [];
	}
}

export async function get_record_by_id(id: number, include_archived: boolean = false): Promise<Record | undefined> {
	try {
		return await timed_query("modules", "get_record_by_id", async () => {
			const archive_where = include_archived ? "" : " AND archived_at IS NULL";
			const by_id_query = `SELECT * FROM modules WHERE id = ?${archive_where} LIMIT 1`;
			const records = (await db.unsafe(by_id_query, [id])) as Record[];
			const record = records[0];
			return record as Record | undefined;
		});
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
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, offset, limit, "id::asc", scope_clause, filter_clauses, archive_filter);
		}

		return await timed_query("modules", "search_records", async () => {
			return cache.search("//system/modules", {
				search,
				offset,
				limit,
				order_by,
				scope_clause,
				filter_clauses,
				archive_filter,
			}, VIEW_DEPENDENCIES, async () => {
				let records: Record[] = [];
				let total: number = 0;

				if (search) {
					const search_term = `%${search}%`;
					const search_where: string[] = [`name LIKE ?`];
					const search_params: any[] = [search_term];

					const search_archive_where = archive_clause(archive_filter);
					if (search_archive_where) { search_where.push(search_archive_where); }

					// Apply scope clause
					if (scope_clause) { search_where.push(`(${scope_clause})`); }

					// Apply filter clauses
					for (const filter of filter_clauses) {
						search_where.push(`(${filter.clause})`);
						search_params.push(...filter.params);
					}

					const search_where_clause = search_where.join(" AND ");
					const data_query = `SELECT * FROM modules WHERE ${search_where_clause} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
					records = (await db.unsafe(data_query, [...search_params, limit, offset])) as Record[];

					const count_query = `SELECT COUNT(*) as count FROM modules WHERE ${search_where_clause}`;
					const count_result = await db.unsafe(count_query, search_params);
					total = (count_result[0] as any)?.count || 0;
				} else {
					const where_clauses: string[] = [];
					const list_archive_where = archive_clause(archive_filter);
					if (list_archive_where) { where_clauses.push(list_archive_where); }
					if (scope_clause) { where_clauses.push(`(${scope_clause})`); }

					// Apply filter clauses (parameterized)
					const filter_params: any[] = [];
					for (const filter of filter_clauses) {
						where_clauses.push(`(${filter.clause})`);
						filter_params.push(...filter.params);
					}

					const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(" AND ")}` : "";
					const data_query = `SELECT * FROM modules ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
					records = (await db.unsafe(data_query, [...filter_params, limit, offset])) as Record[];

					const count_where = where_clauses.length > 0 ? ` WHERE ${where_clauses.join(" AND ")}` : "";
					const count_query = `SELECT COUNT(*) as count FROM modules${count_where}`;
					const count_result = await db.unsafe(count_query, filter_params);
					total = (count_result[0] as any)?.count || 0;
				}

				return { records, total };
			});
		});
	} catch (error) {
		console.error("Error searching records:", error);
		return { records: [], total: 0 };
	}
}
export async function create_record(record: Omit<Record, "id">): Promise<Record> {
	try {
		return await timed_query("modules", "create_record", async () => {
			const insert_result = await db`INSERT INTO modules (code, name, description) VALUES (${record.code}, ${record.name}, ${record.description})`;
			const get_result = await db`SELECT * FROM modules WHERE id = ${insert_result.lastInsertRowid} LIMIT 1`;
			return get_result[0] as Record;
		});
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: number, record: Omit<Record, "id">): Promise<Record | undefined> {
	try {
		return await timed_query("modules", "update_record", async () => {
			await db`UPDATE modules SET code = ${record.code}, name = ${record.name}, description = ${record.description} WHERE id = ${id}`;
			const records = await db`SELECT * FROM modules WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function archive_record(id: number, archived_by_user_id: number | null): Promise<boolean> {
	try {
		return await timed_query("modules", "archive_record", async () => {
			const result = await db`UPDATE modules SET archived_at = CURRENT_TIMESTAMP, archived_by_user_id = ${archived_by_user_id} WHERE id = ${id} AND archived_at IS NULL`;
			return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error archiving record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) { throw error; }
		return false;
	}
}

export async function restore_record(id: number): Promise<boolean> {
	try {
		return await timed_query("modules", "restore_record", async () => {
			const result = await db`UPDATE modules SET archived_at = NULL, archived_by_user_id = NULL WHERE id = ${id} AND archived_at IS NOT NULL`;
			return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error restoring record:", error);
		return false;
	}
}

export async function get_archive_counts(scope_clause: string = ""): Promise<ArchiveCounts> {
	try {
		return await timed_query("modules", "get_archive_counts", async () => {
			const counts_query = archive_counts_query("modules", scope_clause);
			const counts_result = await db.unsafe(counts_query, []);
			return to_archive_counts(counts_result[0]);
		});
	} catch (error) {
		console.error("Error fetching archive counts:", error);
		return { total: 0, live: 0, archived: 0 };
	}
}
