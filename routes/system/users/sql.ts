import { db } from "$config/db";

// Any write here that changes a user's modules_tags (or deletes a user) must
// call invalidate_authz(id) so the in-process authz cache re-reads immediately
// instead of serving stale permissions for up to the cache TTL.
import { invalidate_authz } from "../auth/middleware";

// db.unsafe() - legacy manual CRUD. Uses dynamic ORDER BY via sort_field regex validation.
// Migrate to generator template (generator/templates/sql.ts) when regenerating this route.

export interface Record {
	id: number;
	email: string;
	name: string;
	nickname: string;
	username: string;
	avatar_filename: string;
	verified_at: string;
	hashed_password: string;
	invitation_code: string;
	modules_tags: string;
	previous_hashed_password: string;
}

export interface Options {
	option_value: number;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		const records = await db`SELECT * FROM users ORDER BY id ASC`;
		return records as Record[];
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_users_select_options(): Promise<Options[]> {
	try {
		const records = await db`SELECT id as option_value, username as option_text FROM users ORDER BY username ASC`;
		return records as Options[];
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_record_by_id(id: number): Promise<Record | undefined> {
	try {
		const records = await db`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
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
			where_clauses.push("(email LIKE ? OR name LIKE ? OR nickname LIKE ? OR username LIKE ?)");
			params.push(search_term, search_term, search_term, search_term);
		}

		if (scope_clause) { where_clauses.push(`(${scope_clause})`); }

		for (const filter of filter_clauses) {
			where_clauses.push(`(${filter.clause})`);
			params.push(...filter.params);
		}

		const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(" AND ")}` : "";
		const query = `SELECT * FROM users ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
		records = await db.unsafe(query, [...params, limit, offset]);

		const count_query = `SELECT COUNT(*) as count FROM users ${where}`;
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
		const insert_result = await db`			INSERT INTO users (email, name, nickname, username, avatar_filename, verified_at, hashed_password, invitation_code, modules_tags, previous_hashed_password) VALUES (${record.email}, ${record.name}, ${record.nickname}, ${record.username}, ${record.avatar_filename}, ${record.verified_at}, ${record.hashed_password}, ${record.invitation_code}, ${record.modules_tags}, ${record.previous_hashed_password})`;
		const get_result = await db`SELECT * FROM users WHERE id = ${insert_result.lastInsertRowid} LIMIT 1`;
		return get_result[0] as Record;
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: number, record: Omit<Record, "id">): Promise<Record | undefined> {
	try {
		await db`UPDATE users SET email = ${record.email}, name = ${record.name}, nickname = ${record.nickname}, username = ${record.username}, avatar_filename = ${record.avatar_filename}, verified_at = ${record.verified_at}, hashed_password = ${record.hashed_password}, invitation_code = ${record.invitation_code}, modules_tags = ${record.modules_tags}, previous_hashed_password = ${record.previous_hashed_password} WHERE id = ${id}`;
		// Drop cached authorization so a modules_tags change takes effect immediately.
		invalidate_authz(id);
		const records = await db`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
		return records[0] as Record | undefined;
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function delete_record(id: number): Promise<boolean> {
	try {
		const result = await db`DELETE FROM users WHERE id = ${id}`;
		// Drop cached authorization so the deleted user's sessions stop resolving.
		invalidate_authz(id);
		return result.affectedRows > 0;
	} catch (error) {
		console.error("Error deleting record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) { throw error; }
		return false;
	}
}
