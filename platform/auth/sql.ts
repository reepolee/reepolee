import { db } from "$config/db";
import { instant_to_sql } from "$lib/temporal";

import type { User_public, User_record } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a DB timestamp value to the SQL string format "YYYY-MM-DD HH:MM:SS".
 *
 * MySQL TIMESTAMP columns are returned as Date objects by Bun's SQL client,
 * while SQLite DATETIME columns are returned as strings. This helper ensures
 * the value is always a string (or null) regardless of the DB backend.
 */
function normalize_timestamp(value: unknown): string | null {
	if (value == null) return null;
	if (typeof value === "string") return value;
	if (value instanceof Date) {
		// Date.toISOString() -> "2024-06-15T14:30:00.000Z"
		// slice to seconds, replace T with space -> "2024-06-15 14:30:00"
		return value.toISOString().slice(0, 19).replace("T", " ");
	}
	// Fallback: coerce via toString
	return String(value);
}

/**
 * Map a raw DB row to a typed User_record, normalizing date fields.
 * This ensures consistent string types regardless of the DB backend
 * (MySQL returns TIMESTAMP as Date, SQLite returns DATETIME as string).
 */
function to_user_record(row: any): User_record {
	return {
		id: row.id,
		email: row.email,
		name: row.name ?? "",
		nickname: row.nickname ?? "",
		username: row.username ?? "",
		avatar_filename: row.avatar_filename ?? "",
		verified_at: normalize_timestamp(row.verified_at),
		created_at: normalize_timestamp(row.created_at) ?? "",
		updated_at: normalize_timestamp(row.updated_at),
		hashed_password: row.hashed_password ?? null,
		invitation_code: row.invitation_code ?? "",
		modules_tags: row.modules_tags ?? "",
		previous_hashed_password: row.previous_hashed_password ?? null,
	};
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function get_user_by_email(email: string): Promise<User_record | undefined> {
	try {
		const rows = await db`SELECT * FROM users WHERE email = ${email} LIMIT 1`;
		return rows[0] ? to_user_record(rows[0]) : undefined;
	} catch (error) {
		console.error("get_user_by_email error:", error);
		return undefined;
	}
}

export async function get_user_by_username(username: string): Promise<User_record | undefined> {
	try {
		const rows = await db`SELECT * FROM users WHERE username = ${username} LIMIT 1`;
		return rows[0] ? to_user_record(rows[0]) : undefined;
	} catch (error) {
		console.error("get_user_by_username error:", error);
		return undefined;
	}
}

export async function get_user_by_id(id: number): Promise<User_record | undefined> {
	try {
		const rows = await db`SELECT * FROM users WHERE id = ${id} LIMIT 1`;
		return rows[0] ? to_user_record(rows[0]) : undefined;
	} catch (error) {
		console.error("get_user_by_id error:", error);
		return undefined;
	}
}

export async function get_user_by_invitation_code(code: string): Promise<User_record | undefined> {
	try {
		const rows = await db`SELECT * FROM users WHERE invitation_code = ${code} LIMIT 1`;
		return rows[0] ? to_user_record(rows[0]) : undefined;
	} catch (error) {
		console.error("get_user_by_invitation_code error:", error);
		return undefined;
	}
}

export async function verify_and_register_user(id: number, name: string, hashed_password: string): Promise<User_record | undefined> {
	try {
		const now = instant_to_sql();

		await db`
			UPDATE users
			SET
				name             = ${name},
				hashed_password  = ${hashed_password},
				verified_at      = ${now},
				updated_at       = ${now}
			WHERE id = ${id}
		`;
		return get_user_by_id(id);
	} catch (error) {
		console.error("verify_and_register_user error:", error);
		return undefined;
	}
}

export async function create_invited_user(email: string, username: string, invitation_code: string): Promise<User_record | undefined> {
	try {
		const now = instant_to_sql();

		const result = await db`
			INSERT INTO users (email, username, invitation_code, created_at)
			VALUES (${email}, ${username}, ${invitation_code}, ${now})
		`;
		return get_user_by_id((result as any).lastInsertRowid);
	} catch (error) {
		console.error("create_invited_user error:", error);
		return undefined;
	}
}

export async function update_user_profile(id: number, data: { name: string; nickname: string; avatar_filename?: string; modules_tags?: string; }): Promise<User_record | undefined> {
	try {
		const existing = await get_user_by_id(id);
		if (!existing) return undefined;

		const now = instant_to_sql();

		await db`
			UPDATE users
			SET
				name             = ${data.name},
				nickname         = ${data.nickname},
				avatar_filename  = ${data.avatar_filename ?? existing.avatar_filename},
				modules_tags      = ${data.modules_tags ?? existing.modules_tags},
				updated_at       = ${now}
			WHERE id = ${id}
		`;
		return get_user_by_id(id);
	} catch (error) {
		console.error("update_user_profile error:", error);
		return undefined;
	}
}

export async function update_user_password(id: number, new_hashed_password: string, previous_hashed_password: string): Promise<boolean> {
	try {
		const now = instant_to_sql();

		await db`
			UPDATE users
			SET
				hashed_password          = ${new_hashed_password},
				previous_hashed_password = ${previous_hashed_password},
				updated_at               = ${now}
			WHERE id = ${id}
		`;
		return true;
	} catch (error) {
		console.error("update_user_password error:", error);
		return false;
	}
}

export function to_public_user(user: User_record): User_public {
	const email = user.email ?? "";
	const name = user.name ?? "";
	const nickname = user.nickname ?? "";
	const username = user.username ?? "";
	const avatar_filename = user.avatar_filename ?? "";
	const modules = user.modules_tags;
	const display_name = nickname || name || username;

	return {
		id: user.id,
		email,
		name,
		nickname,
		username,
		avatar_filename,
		modules_tags: modules,
		display_name,
	};
}
