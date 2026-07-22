import { require_env } from "$lib/env";
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

export function get_test_db(): SQL {
	const url = require_env("TEST_CONNECTION_STRING");
	enforce_test_db(url);
	return new SQL(url);
}
