import { describe, expect, test } from "bun:test";

import { enforce_test_db, extract_db_name } from "$config/test_db";

describe("extract_db_name", () => {
	test("extracts database name from MySQL URL", () => {
		const result = extract_db_name("mysql://user:pass@localhost/my_test_db");
		expect(result).toBe("my_test_db");
	});

	test("extracts database name from MySQL URL with quotes", () => {
		const result = extract_db_name("\"mysql://user:pass@localhost/my_test_db\"");
		expect(result).toBe("my_test_db");
	});

	test("extracts database name from MySQL URL with single quotes", () => {
		const result = extract_db_name("'mysql://user:pass@localhost/my_test_db'");
		expect(result).toBe("my_test_db");
	});

	test("extracts filename from sqlite: URL", () => {
		const result = extract_db_name("sqlite:test_data.db");
		expect(result).toBe("test_data.db");
	});

	test("extracts filename from sqlite: URL with double slash", () => {
		const result = extract_db_name("sqlite://test_data.db");
		expect(result).toBe("test_data.db");
	});

	test("extracts database name from MySQL URL with dashes", () => {
		const result = extract_db_name("mysql://user:pass@m4mini/gsv-bun_test");
		expect(result).toBe("gsv-bun_test");
	});

	test("extracts database name without 'test' in it", () => {
		const result = extract_db_name("mysql://user:pass@localhost/production");
		expect(result).toBe("production");
	});

	test("handles URL-encoded characters", () => {
		const result = extract_db_name("mysql://user:pass@localhost/my%20test%20db");
		expect(result).toBe("my%20test%20db");
	});
});

describe("enforce_test_db", () => {
	test("passes when DB name contains 'test'", () => expect(() => enforce_test_db("mysql://user:pass@localhost/test_db")).not.toThrow());

	test("passes when DB name contains 'TEST' (uppercase)", () => expect(() => enforce_test_db("mysql://user:pass@localhost/TEST_db")).not.toThrow());

	test("passes when DB name contains 'Test' (mixed case)", () => expect(() => enforce_test_db("mysql://user:pass@localhost/my_Test_db")).not.toThrow());

	test("passes when sqlite DB name contains 'test'", () => expect(() => enforce_test_db("sqlite:test_data.db")).not.toThrow());

	test("exits with error when DB name does not contain 'test'", () => {
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			expect(() => enforce_test_db("mysql://user:pass@localhost/production")).toThrow("process.exit(1)");
		} finally {
			(process as any).exit = original_exit;
		}
	});

	test("exits with error when sqlite DB name does not contain 'test'", () => {
		const original_exit = process.exit;
		(process as any).exit = ((code?: number) => { throw new Error(`process.exit(${code})`); }) as any;

		try {
			expect(() => enforce_test_db("sqlite:production.db")).toThrow("process.exit(1)");
		} finally {
			(process as any).exit = original_exit;
		}
	});
});
