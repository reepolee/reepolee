import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";

import { make_test_db_mock, get_test_db_connection } from "$root/test_helpers";

const DB_TIMEOUT_MS = 5_000;

let test_db: SQL | null = null;

try {
	test_db = await Promise.race([
		get_test_db_connection(),
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Database connection timed out after ${DB_TIMEOUT_MS}ms`)), DB_TIMEOUT_MS)),
	]);

	mock.module("$config/db", () => make_test_db_mock(test_db));
} catch (e: any) {
	console.error(`[auth/sql.test.ts] ${e.message} - skipping MySQL-dependent tests`);
}

const run = test_db ? describe : describe.skip;

const { get_user_by_email, get_user_by_username, get_user_by_id, get_user_by_invitation_code, verify_and_register_user, create_invited_user, update_user_profile, update_user_password, to_public_user } = await import(
	"./sql"
);

// Clean database before each test
async function clean_db() { await test_db!.unsafe("DELETE FROM users"); }

beforeEach(async () => await clean_db());

run("auth/sql.get_user_by_email", () => {
	test("returns user when email exists", async () => {
		await test_db!`INSERT INTO users (email, username, created_at) VALUES (${"test@example.com"}, ${"testuser"}, ${"2026-01-01 00:00:00"})`;

		const user = await get_user_by_email("test@example.com");
		expect(user).toBeDefined();
		expect(user?.email).toBe("test@example.com");
		expect(user?.username).toBe("testuser");
	});

	test("returns undefined when email does not exist", async () => {
		const user = await get_user_by_email("nonexistent@example.com");
		expect(user).toBeUndefined();
	});
});

run("auth/sql.get_user_by_username", () => {
	test("returns user when username exists", async () => {
		await test_db!`INSERT INTO users (email, username, created_at) VALUES (${"john@example.com"}, ${"johndoe"}, ${"2026-01-01 00:00:00"})`;

		const user = await get_user_by_username("johndoe");
		expect(user).toBeDefined();
		expect(user?.username).toBe("johndoe");
		expect(user?.email).toBe("john@example.com");
	});

	test("returns undefined when username does not exist", async () => {
		const user = await get_user_by_username("nonexistent_user");
		expect(user).toBeUndefined();
	});
});

run("auth/sql.get_user_by_id", () => {
	test("returns user when ID exists", async () => {
		await test_db!`INSERT INTO users (email, username, created_at) VALUES (${"alice@example.com"}, ${"alice"}, ${"2026-01-01 00:00:00"})`;
		const rows = await test_db!`SELECT id FROM users WHERE email = ${"alice@example.com"} LIMIT 1`;
		const user_id = (rows[0] as any).id;

		const user = await get_user_by_id(user_id);
		expect(user).toBeDefined();
		expect(user?.email).toBe("alice@example.com");
	});

	test("returns undefined when ID does not exist", async () => {
		const user = await get_user_by_id(999999);
		expect(user).toBeUndefined();
	});
});

run("auth/sql.get_user_by_invitation_code", () => {
	test("returns user when invitation code matches", async () => {
		const code = "invite_abc123";
		await test_db!`INSERT INTO users (email, username, invitation_code, created_at) VALUES (${"invited@example.com"}, ${"invited_user"}, ${code}, ${"2026-01-01 00:00:00"})`;

		const user = await get_user_by_invitation_code(code);
		expect(user).toBeDefined();
		expect(user?.invitation_code).toBe(code);
		expect(user?.email).toBe("invited@example.com");
	});

	test("returns undefined when invitation code does not exist", async () => {
		const user = await get_user_by_invitation_code("nonexistent_code");
		expect(user).toBeUndefined();
	});
});

run("auth/sql.verify_and_register_user", () => test("updates user with name, password, and verified_at", async () => {
	await test_db!`INSERT INTO users (email, username, created_at) VALUES (${"newuser@example.com"}, ${"newuser"}, ${"2026-01-01 00:00:00"})`;
	const rows = await test_db!`SELECT id FROM users WHERE email = ${"newuser@example.com"} LIMIT 1`;
	const user_id = (rows[0] as any).id;

	const updated = await verify_and_register_user(user_id, "New User", "hashed_pwd_123");
	expect(updated).toBeDefined();
	expect(updated?.name).toBe("New User");
	expect(updated?.hashed_password).toBe("hashed_pwd_123");
	expect(updated?.verified_at).toBeTruthy();
}));

run("auth/sql.create_invited_user", () => test("inserts user and returns the created user", async () => {
	const code = "invite_xyz789";
	const user = await create_invited_user("guest@example.com", "guest_user", code);

	expect(user).toBeDefined();
	expect(user?.email).toBe("guest@example.com");
	expect(user?.username).toBe("guest_user");
	expect(user?.invitation_code).toBe(code);
}));

run("auth/sql.update_user_profile", () => {
	test("updates user name and nickname, preserves avatar", async () => {
		await test_db!`INSERT INTO users (email, username, name, nickname, avatar_filename, created_at) VALUES (${"profile@example.com"}, ${"profile_user"}, ${"Old Name"}, ${"old_nick"}, ${"avatar.jpg"}, ${"2026-01-01 00:00:00"})`;
		const rows = await test_db!`SELECT id FROM users WHERE email = ${"profile@example.com"} LIMIT 1`;
		const user_id = (rows[0] as any).id;

		const updated = await update_user_profile(user_id, { name: "New Name", nickname: "new_nick" });

		expect(updated).toBeDefined();
		expect(updated?.name).toBe("New Name");
		expect(updated?.nickname).toBe("new_nick");
		expect(updated?.avatar_filename).toBe("avatar.jpg");
	});

	test("updates avatar_filename when provided", async () => {
		await test_db!`INSERT INTO users (email, username, avatar_filename, created_at) VALUES (${"avatar@example.com"}, ${"avatar_user"}, ${"old.jpg"}, ${"2026-01-01 00:00:00"})`;
		const rows = await test_db!`SELECT id FROM users WHERE email = ${"avatar@example.com"} LIMIT 1`;
		const user_id = (rows[0] as any).id;

		const updated = await update_user_profile(user_id, {
			name: "User",
			nickname: "nick",
			avatar_filename: "new.jpg",
		});

		expect(updated?.avatar_filename).toBe("new.jpg");
	});

	test("returns undefined for non-existent user", async () => {
		const result = await update_user_profile(999999, { name: "Test", nickname: "test" });

		expect(result).toBeUndefined();
	});
});

run("auth/sql.update_user_password", () => {
	test("updates hashed_password and previous_hashed_password", async () => {
		await test_db!`INSERT INTO users (email, username, hashed_password, created_at) VALUES (${"pwd@example.com"}, ${"pwd_user"}, ${"old_hash"}, ${"2026-01-01 00:00:00"})`;
		const rows = await test_db!`SELECT id FROM users WHERE email = ${"pwd@example.com"} LIMIT 1`;
		const user_id = (rows[0] as any).id;

		const success = await update_user_password(user_id, "new_hash", "old_hash");
		expect(success).toBe(true);

		const updated = await get_user_by_id(user_id);
		expect(updated?.hashed_password).toBe("new_hash");
		expect(updated?.previous_hashed_password).toBe("old_hash");
	});

	test("returns true even for non-existent user (no error thrown)", async () => {
		// Function doesn't validate row count, just SQL success
		const success = await update_user_password(999999, "new_hash", "old_hash");
		expect(success).toBe(true);
	});
});

describe("auth/sql.to_public_user", () => {
	test("returns public user with display_name from nickname", () => {
		const user_record = {
			id: 1,
			email: "test@example.com",
			name: "Full Name",
			nickname: "nick",
			username: "testuser",
			avatar_filename: "avatar.jpg",
			verified_at: "2026-01-01 12:00:00",
			created_at: "2026-01-01 10:00:00",
			updated_at: "2026-01-01 11:00:00",
			hashed_password: "hash",
			invitation_code: "code",
			modules_tags: "admin,user",
			previous_hashed_password: null,
		};

		const public_user = to_public_user(user_record);

		expect(public_user.id).toBe(1);
		expect(public_user.email).toBe("test@example.com");
		expect(public_user.name).toBe("Full Name");
		expect(public_user.nickname).toBe("nick");
		expect(public_user.display_name).toBe("nick");
		expect(public_user.modules_tags).toBe("admin,user");
		expect((public_user as any).hashed_password).toBeUndefined();
		expect((public_user as any).verified_at).toBeUndefined();
	});

	test("returns display_name from name when nickname is empty", () => {
		const user_record = {
			id: 2,
			email: "user@example.com",
			name: "Just Name",
			nickname: "",
			username: "user2",
			avatar_filename: "",
			verified_at: null,
			created_at: "2026-01-01 10:00:00",
			updated_at: null,
			hashed_password: null,
			invitation_code: "",
			modules_tags: "",
			previous_hashed_password: null,
		};

		const public_user = to_public_user(user_record);

		expect(public_user.display_name).toBe("Just Name");
		expect(public_user.nickname).toBe("");
	});

	test("returns display_name from username when name and nickname are empty", () => {
		const user_record = {
			id: 3,
			email: "minimal@example.com",
			name: "",
			nickname: "",
			username: "minimal_user",
			avatar_filename: "",
			verified_at: null,
			created_at: "2026-01-01 10:00:00",
			updated_at: null,
			hashed_password: null,
			invitation_code: "",
			modules_tags: "",
			previous_hashed_password: null,
		};

		const public_user = to_public_user(user_record);

		expect(public_user.display_name).toBe("minimal_user");
	});
});
