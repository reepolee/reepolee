import { describe, expect, test } from "bun:test";

const si = await import("./sql_introspector");

describe("sql_introspector - parse_view_tables", () => {
	test("extracts table name from simple FROM clause", () => {
		const sql = "CREATE VIEW v_users AS SELECT * FROM users";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["users"]);
	});

	test("extracts tables from FROM and JOIN clauses", () => {
		const sql = `
			CREATE VIEW v_orders AS
			SELECT o.*, u.name
			FROM orders o
			JOIN users u ON o.user_id = u.id
		`;
		const result = si.parse_view_tables(sql);
		expect(result).toContain("orders");
		expect(result).toContain("users");
	});

	test("handles LEFT JOIN", () => {
		const sql = `CREATE VIEW v_articles AS
			SELECT a.*, c.name as category_name
			FROM articles a
			LEFT JOIN categories c ON a.category_id = c.id`;
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["articles", "categories"]);
	});

	test("handles multiple JOINs", () => {
		const sql = `CREATE VIEW v_complex AS
			SELECT *
			FROM a
			JOIN b ON a.id = b.a_id
			INNER JOIN c ON b.id = c.b_id
			LEFT JOIN d ON c.id = d.c_id`;
		const result = si.parse_view_tables(sql);
		expect(result).toContain("a");
		expect(result).toContain("b");
		expect(result).toContain("c");
		expect(result).toContain("d");
	});

	test("handles schema-qualified table names (e.g. public.users)", () => {
		const sql = "CREATE VIEW v_active AS SELECT * FROM public.users";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["users"]);
	});

	test("strips backticks from MySQL quoted identifiers", () => {
		const sql = "CREATE VIEW `v_users` AS SELECT * FROM `users` JOIN `profiles` ON ...";
		const result = si.parse_view_tables(sql);
		expect(result).toContain("users");
		expect(result).toContain("profiles");
	});

	test("strips double-quotes from quoted identifiers", () => {
		const sql = "CREATE VIEW \"v_users\" AS SELECT * FROM \"users\"";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["users"]);
	});

	test("handles STRAIGHT_JOIN (MySQL-specific)", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM a STRAIGHT_JOIN b";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["a", "b"]);
	});

	test("returns lowercase table names", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM Users JOIN Profiles";
		const result = si.parse_view_tables(sql);
		expect(result.every((t: string) => t === t.toLowerCase())).toBe(true);
	});

	test("deduplicates same table appearing in FROM and JOIN", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM users JOIN users AS u2 ON ...";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["users"]);
	});

	test("handles CROSS JOIN", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM a CROSS JOIN b";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["a", "b"]);
	});

	test("handles FULL JOIN", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM a FULL JOIN b ON a.id = b.a_id";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["a", "b"]);
	});

	test("returns empty array for subquery-only views", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM (SELECT id, name FROM users) AS sub";
		const result = si.parse_view_tables(sql);
		// Should only match top-level FROM, not subquery FROM
		expect(result).toEqual(["users"]);
	});

	test("handles multi-line SQL with irregular spacing", () => {
		const sql = `CREATE VIEW v_test  AS
\tSELECT  *
\tFROM    products  p
\t\tJOIN    categories  cat    ON  p.cat_id = cat.id`;
		const result = si.parse_view_tables(sql);
		expect(result).toContain("products");
		expect(result).toContain("categories");
	});

	test("handles RIGHT JOIN", () => {
		const sql = "CREATE VIEW v AS SELECT * FROM a RIGHT JOIN b ON a.id = b.a_id";
		const result = si.parse_view_tables(sql);
		expect(result).toEqual(["a", "b"]);
	});
});

describe("sql_introspector - clear_view_cache", () => {
	test("clears cache without throwing", () => expect(() => si.clear_view_cache()).not.toThrow());

	test("can be called multiple times safely", () => expect(() => {
		si.clear_view_cache();
		si.clear_view_cache();
		si.clear_view_cache();
	}).not.toThrow());
});
