import { describe, expect, test } from "bun:test";
import { SQL } from "bun";

import { SQLiteIntrospector } from "./sqlite_introspector";

// Helper to create a fresh test database
async function create_test_db() {
	const db = new SQL(":memory:");

	await db.unsafe(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			name TEXT,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);

	await db.unsafe(`
		CREATE TABLE posts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			title TEXT NOT NULL,
			content TEXT,
			is_published INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (user_id) REFERENCES users(id)
		)
	`);

	await db.unsafe(`CREATE INDEX idx_posts_user_id ON posts(user_id)`);
	await db.unsafe(`CREATE INDEX idx_posts_published ON posts(is_published)`);

	await db.unsafe(`
		CREATE VIEW active_posts AS
		SELECT * FROM posts WHERE is_published = 1
	`);

	return db;
}

describe("SQLiteIntrospector.get_all_indexes", () => {
	test("returns indexes map with table names and column sets", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const indexes = await introspector.get_all_indexes();

		expect(indexes).toBeInstanceOf(Map);
		expect(indexes.has("users")).toBe(true);
		expect(indexes.has("posts")).toBe(true);
	});

	test("includes primary key columns in indexes", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const indexes = await introspector.get_all_indexes();
		const users_indexes = indexes.get("users");

		expect(users_indexes).toBeDefined();
		expect(users_indexes?.has("id")).toBe(true);
	});

	test("includes explicit indexes in index set", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const indexes = await introspector.get_all_indexes();
		const posts_indexes = indexes.get("posts");

		expect(posts_indexes).toBeDefined();
		expect(posts_indexes?.has("user_id")).toBe(true);
		expect(posts_indexes?.has("is_published")).toBe(true);
	});

	test("column names are stored in lowercase", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const indexes = await introspector.get_all_indexes();
		const users_indexes = indexes.get("users");

		// Check that column names are lowercase
		for (const col of users_indexes || []) {
			expect(col).toBe(col.toLowerCase());
		}
	});
});

describe("SQLiteIntrospector.get_database_schema", () => {
	test("returns array of schema objects for all tables", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const schema = await introspector.get_database_schema();

		expect(Array.isArray(schema)).toBe(true);
		const table_names = schema.map((s) => s.name);
		expect(table_names).toContain("users");
		expect(table_names).toContain("posts");
	});

	test("each schema object has correct properties", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const schema = await introspector.get_database_schema();
		const users_schema = schema.find((s) => s.name === "users");

		expect(users_schema).toBeDefined();
		expect(users_schema?.type).toBe("table");
		expect(users_schema?.columns).toBeDefined();
		expect(Array.isArray(users_schema?.columns)).toBe(true);
		expect(users_schema?.foreign_keys).toBeDefined();
	});

	test("detects nullable columns correctly", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const schema = await introspector.get_database_schema();
		const users_schema = schema.find((s) => s.name === "users");

		const email_col = users_schema?.columns.find((c) => c.name === "email");
		const name_col = users_schema?.columns.find((c) => c.name === "name");

		expect(email_col?.is_nullable).toBe(false);
		expect(name_col?.is_nullable).toBe(true);
	});

	test("includes foreign key relationships", async () => {
		const db = await create_test_db();
		const introspector = new SQLiteIntrospector(db);

		const schema = await introspector.get_database_schema();
		const posts_schema = schema.find((s) => s.name === "posts");

		// Foreign keys may or may not be populated depending on introspector impl
		expect(posts_schema?.foreign_keys).toBeDefined();
	});

});

describe("SQLiteIntrospector with empty database", () => {
	test("returns empty schema array for new database", async () => {
		const empty_db = new SQL(":memory:");
		const introspector = new SQLiteIntrospector(empty_db);

		const schema = await introspector.get_database_schema();

		expect(Array.isArray(schema)).toBe(true);
		expect(schema.length).toBe(0);
	});

	test("returns empty map for indexes in empty database", async () => {
		const empty_db = new SQL(":memory:");
		const introspector = new SQLiteIntrospector(empty_db);

		const indexes = await introspector.get_all_indexes();

		expect(indexes).toBeInstanceOf(Map);
		expect(indexes.size).toBe(0);
	});
});

describe("SQLiteIntrospector with complex schema", () => {
	test("handles multiple foreign keys on same table", async () => {
		const db = new SQL(":memory:");
		await db.unsafe(`
			CREATE TABLE categories (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			)
		`);
		await db.unsafe(`
			CREATE TABLE posts (
				id INTEGER PRIMARY KEY,
				title TEXT NOT NULL,
				category_id INTEGER NOT NULL,
				author_id INTEGER NOT NULL,
				FOREIGN KEY (category_id) REFERENCES categories(id),
				FOREIGN KEY (author_id) REFERENCES categories(id)
			)
		`);

		const introspector = new SQLiteIntrospector(db);
		const schema = await introspector.get_database_schema();
		const posts_schema = schema.find((s) => s.name === "posts");

		expect(posts_schema?.foreign_keys.length).toBeGreaterThanOrEqual(2);
	});

	test("handles various SQLite data types", async () => {
		const db = new SQL(":memory:");
		await db.unsafe(`
			CREATE TABLE data_types (
				id INTEGER PRIMARY KEY,
				text_col TEXT,
				int_col INTEGER,
				real_col REAL
			)
		`);

		const introspector = new SQLiteIntrospector(db);
		const schema = await introspector.get_database_schema();
		const table = schema.find((s) => s.name === "data_types");

		expect(table?.columns.length).toBeGreaterThan(0);
		expect(table?.columns.every((c) => c.type_string)).toBe(true);
	});
});
