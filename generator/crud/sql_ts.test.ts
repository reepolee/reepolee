import { describe, expect, test } from "bun:test";

// Import the real function from the generator
// parse_view_tables was moved to sql_introspector.ts in the Phase 3 refactoring
const { parse_view_tables } = await import("./sql_introspector");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parse_view_tables", () => {
	test("simple FROM table", () => {
		const sql = `SELECT * FROM legal_entities WHERE id > 0`;
		expect(parse_view_tables(sql)).toEqual(["legal_entities"]);
	});

	test("fully qualified db.table FROM", () => {
		const sql = `SELECT id, name FROM mydb.legal_entities WHERE active = 1`;
		expect(parse_view_tables(sql)).toEqual(["legal_entities"]);
	});

	test("backtick-qualified `db`.`table` FROM", () => {
		const sql = "SELECT `legal_entities`.`id`, `legal_entities`.`name` FROM `mydb`.`legal_entities`";
		expect(parse_view_tables(sql)).toEqual(["legal_entities"]);
	});

	test("with JOIN clauses", () => {
		const sql = `SELECT u.id, u.name, a.city
			FROM mydb.users u
			JOIN mydb.addresses a ON a.user_id = u.id`;
		expect(parse_view_tables(sql)).toEqual(["users", "addresses"]);
	});

	test("LEFT JOIN with qualified names", () => {
		const sql = `SELECT e.*, c.name
			FROM mydb.employees e
			LEFT JOIN mydb.companies c ON c.id = e.company_id`;
		expect(parse_view_tables(sql)).toEqual(["employees", "companies"]);
	});

	test("v_legal_entities exact SQL from user", () => {
		const sql = `SELECT
			\`legal_entities\`.\`id\` AS \`id\`,
			\`legal_entities\`.\`name\` AS \`name\`,
			\`legal_entities\`.\`vat_number\` AS \`vat_number\`,
			CONCAT(
				\`legal_entities\`.\`prs_ulica\`, ' ',
				\`legal_entities\`.\`prs_hisna_st\`,
				\`legal_entities\`.\`prs_hisna_st_dodatek\`
			) AS \`ulica\`,
			\`legal_entities\`.\`search_text\` AS \`search_text\`
		FROM
			\`legal_entities\``;
		expect(parse_view_tables(sql)).toEqual(["legal_entities"]);
	});

	test("no FROM clause returns empty", () => {
		const sql = `SELECT 1`;
		expect(parse_view_tables(sql)).toEqual([]);
	});

	test("STRAIGHT_JOIN syntax", () => {
		const sql = `SELECT * FROM mydb.products STRAIGHT_JOIN mydb.categories ON products.category_id = categories.id`;
		expect(parse_view_tables(sql)).toEqual(["products", "categories"]);
	});
});
