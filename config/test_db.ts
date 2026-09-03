import { get_connection_string } from "$lib/env";
import { SQL } from "bun";

export function extract_db_name(url: string): string {
	const clean = url.replace(/^["']|["']$/g, "").trim();

	if (clean.startsWith("mysql://")) {
		const url_obj = new URL(clean);
		return url_obj.pathname.replace(
			/^\//,
			""
		);
	}

	if (clean.startsWith("sqlite:")) {
		const path = clean.slice("sqlite:".length).replace(
			/^\/\//,
			""
		);
		return path;
	}

	try {
		const url_obj = new URL(clean);
		return url_obj.pathname.replace(
			/^\//,
			""
		);
	} catch {
		return clean;
	}
}

export function enforce_test_db(url: string): void {
	const db_name = extract_db_name(url);
	const lower = db_name.toLowerCase();

	if (!lower.includes("test")) {
		console.error(
			`✗ Database "${db_name}" does not contain "test" in its name.\n  Refusing to run tests on a non-test database.\n  Set TEST_CONNECTION_STRING to a database with "test" in the name.`
		);
		process.exit(1);
	}
}

export async function get_test_db(): Promise<SQL> {
	const url = get_connection_string("TEST");
	enforce_test_db(url);
	const db = new SQL(url);

	// SQLite only allows one writer at a time. Without WAL + a busy timeout,
	// the many test files/processes sharing this file collide instantly with
	// SQLITE_BUSY instead of briefly waiting - see config/db.ts for the same
	// pattern on the app's own connection. These must be awaited: Bun's SQL
	// driver does not guarantee an unawaited PRAGMA applies before the
	// caller's next query on this connection.
	if (url.replace(/^["']|["']$/g, "").trim().startsWith("sqlite:")) {
		await db.unsafe("PRAGMA journal_mode = WAL");
		await db.unsafe("PRAGMA busy_timeout = 5000");
	}

	return db;
}
