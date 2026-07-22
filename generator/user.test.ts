import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";

import { get_test_db_connection, make_test_db_mock } from "$root/test_helpers";

// ---------------------------------------------------------------------------
// Test DB setup - cloned MySQL test DB via TEST_CONNECTION_STRING
// Run `bun run db:clone-test -- --yes --no-data` first to set up schema.
//
// Connection has a 5s timeout to avoid hanging indefinitely on platforms
// where Bun's SQL driver has connection issues (e.g., Windows Bun canary).
// ---------------------------------------------------------------------------

const DB_TIMEOUT_MS = 5_000;

let test_db: SQL | null = null;
let user_lib: any = null;

try {
	test_db = await Promise.race([
		get_test_db_connection(),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Database connection timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS)),
	]);

	mock.module("$config/db", () => make_test_db_mock(test_db));
	mock.module("$config/db_cli", () => ({
		db_cli: test_db,
		sync_db_cli: () => false,
		close_db_cli: async () => {},
	}));

	user_lib = await import("./user_lib");
} catch (e: any) {
	console.error(`[user.test.ts] ${e.message} - skipping MySQL-dependent tests`);
}

const run = test_db && user_lib ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helper: seed a test user directly into the test DB
// ---------------------------------------------------------------------------

async function seed_user(username: string, email: string, modules: string = "user") {
	await test_db!`
		INSERT INTO users (email, name, nickname, username, avatar_filename, invitation_code, modules_tags, created_at)
		VALUES (${email}, ${"Seed"}, ${""}, ${username}, ${""}, ${""}, ${modules}, ${"2026-01-01 00:00:00"})
	`;
}

// ---------------------------------------------------------------------------
// Cleanup between tests: DELETE FROM users via the same test_db connection
// that create_user uses (via mocked db_cli), ensuring visibility.
// ---------------------------------------------------------------------------

async function clean_db() { await test_db!.unsafe("DELETE FROM users"); }

// ===========================================================================
// Tests
// ===========================================================================

run("create_user", () => {
	// Clean the users table before each test so we start fresh.
	// create_user uses the mocked db_cli (same test_db connection), so the
	// DELETE is visible to all operations within the test.
	beforeEach(async () => await clean_db());

	// -----------------------------------------------------------------------
	// Basic creation
	// -----------------------------------------------------------------------

	test("first user gets system modules when table is empty", async () => {
		const result = await user_lib.create_user("testuser", "test@example.com", "secret123", "");

		expect(result).toEqual({ username: "testuser" });

		const rows = await test_db!`SELECT * FROM users WHERE username = ${"testuser"}`;
		expect(rows.length).toBe(1);
		const row = rows[0];

		expect(row.username).toBe("testuser");
		expect(row.email).toBe("test@example.com");
		expect(row.name).toBe("testuser");
		expect(row.verified_at).not.toBeNull();
		expect(row.modules_tags).toBe("system,examples");
		expect(row.invitation_code).toBe("");
		expect(row.hashed_password).not.toBeNull();
		expect(row.hashed_password).not.toBe("secret123");
	});

	test("creates a new user and the password is verifiable", async () => {
		await user_lib.create_user("verify", "verify@example.com", "my_password");

		const rows = await test_db!`SELECT * FROM users WHERE username = ${"verify"}`;
		const hash: string = rows[0].hashed_password;

		const valid = await Bun.password.verify("my_password", hash);
		expect(valid).toBe(true);
	});

	test("custom modules are honored for non-first users", async () => {
		// Seed a first user so the table is not empty
		await seed_user("first", "first@example.com");

		await user_lib.create_user("second", "second@example.com", "pass", "admin,editor");

		const rows = await test_db!`SELECT * FROM users WHERE username = ${"second"}`;
		expect(rows[0].modules_tags).toBe("admin,editor");
	});

	// -----------------------------------------------------------------------
	// Normalization
	// -----------------------------------------------------------------------

	test("lowercases the username", async () => {
		await user_lib.create_user("TESTUSER", "test@example.com", "p");

		const rows = await test_db!`SELECT * FROM users WHERE username = ${"testuser"}`;
		expect(rows.length).toBe(1);
	});

	test("trims whitespace from username", async () => {
		await user_lib.create_user("  spaced  ", "spaced@example.com", "p");

		const rows = await test_db!`SELECT * FROM users WHERE username = ${"spaced"}`;
		expect(rows.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// Duplicate detection
	// -----------------------------------------------------------------------

	test("throws when username already exists", async () => {
		await seed_user("dupuser", "dup@example.com");

		expect(user_lib.create_user("dupuser", "other@example.com", "other")).rejects.toThrow("dupuser already exists");
	});

	test("throws on duplicate regardless of case", async () => {
		await seed_user("dupuser", "dup@example.com");

		expect(user_lib.create_user("DUPUSER", "other@example.com", "other")).rejects.toThrow("dupuser already exists");
	});

	test("duplicate check does not interfere with other usernames", async () => {
		await seed_user("existing", "existing@example.com");
		await user_lib.create_user("newuser", "new@example.com", "pass");

		const rows = await test_db!`SELECT * FROM users WHERE username = ${"newuser"}`;
		expect(rows.length).toBe(1);
	});
});
