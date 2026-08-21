/**
* Library module for creating a confirmed user directly in the database.
*
* Separated from the CLI wrapper so it can be unit-tested with mocked DB.
*
* Usage (library):
* import { create_user } from "./user_lib";
* await create_user("jane", "jane@example.com", "secret123", "admin");
*
* Usage (CLI - see user.ts):
* bun generator/user.ts jane jane@example.com secret123
*/

import { local_js_datetime_to_iso_string } from "$lib/temporal";
import { SQL } from "bun";

async function hash_password(password: string): Promise<string> { return await Bun.password.hash(password); }

/**
* The subset of user fields that this module populates.
* Used as the return type so callers can read back what was inserted.
*/
export interface Created_user {
	username: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function create_user(
	username: string,
	email: string,
	password: string,
	modules: string = "system,examples",
	connection_string?: string,
): Promise<Created_user> {
	const { db_cli, close_db_cli } = await import("../config/db_cli");

	// If a connection string is provided, create a fresh connection to bypass
	// any stale db_cli (e.g. when .env was updated after reeman startup).
	const use_fresh = !!connection_string;
	const db = use_fresh ? new SQL(connection_string!) : db_cli;
	const keepalive = use_fresh ? setInterval(() => {}, 2_147_483_647) : null;

	const normalized_username = username.trim().toLowerCase();
	const normalized_email = email.trim().toLowerCase();

	try {
		// -----------------------------------------------------------------------
		// Check for duplicate username
		// -----------------------------------------------------------------------

		const existing = await db`SELECT id FROM users WHERE username = ${normalized_username} LIMIT 1`;
		if (existing.length > 0) { throw new Error(`User ${normalized_username} already exists`); }

		// -----------------------------------------------------------------------
		// If the users table is empty, this is the first user - grant system access
		// -----------------------------------------------------------------------
		const user_count_result = await db`SELECT COUNT(*) as count FROM users`;
		const user_count = Number(user_count_result[0]?.count || 0);
		if (user_count === 0 && modules === "") { modules = "system,examples"; }

		// -----------------------------------------------------------------------
		// Derive display name from username
		// -----------------------------------------------------------------------
		const name = normalized_username;

		// -----------------------------------------------------------------------
		// Hash password and build timestamps
		// -----------------------------------------------------------------------
		const hashed_password = await hash_password(password);

		// -----------------------------------------------------------------------
		// Insert the new user
		// -----------------------------------------------------------------------

		const verified_at = local_js_datetime_to_iso_string();

		await db`INSERT INTO users (
				email,
				name,
				username,
				verified_at,
				hashed_password,
				modules_tags
			) VALUES (
				${normalized_email},
				${name},
				${normalized_username},
				${verified_at},
				${hashed_password},
				${modules}
			)`;

		return { username: normalized_username };
	} finally {
		if (use_fresh) {
			clearInterval(keepalive!);
			await db.close();
		} else {
			await close_db_cli();
		}
	}
}
