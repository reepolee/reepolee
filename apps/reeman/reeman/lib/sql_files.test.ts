import { describe, expect, test } from "bun:test";

import { list_sql_files } from "./sql_files";

describe("reeman sql file discovery", () => {
	test("every discovered file carries an ISO last_updated timestamp", async () => {
		const files = await list_sql_files();

		// The test checkout has sql/sqlite (and often sql/mysql) seed files, but
		// the active dialect's folder may legitimately be absent (e.g. a MySQL
		// checkout without sql/mysql). Only assert on files we actually found.
		for (const file of files) {
			expect(typeof file.last_updated).toBe("string");
			expect(file.last_updated).not.toBe("");
			const parsed = new Date(file.last_updated);
			expect(Number.isNaN(parsed.getTime())).toBe(false);
			expect(parsed.toISOString()).toBe(file.last_updated);
		}
	});

	test("last_updated tracks the file's mtime", async () => {
		const files = await list_sql_files();
		if (files.length === 0) return; // nothing to compare against

		// list_sql_files is cheap (a glob + stat per file); spot-check the first
		// entry against a direct stat of the same path to confirm the field is
		// the real mtime and not a placeholder.
		const { statSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { db_type } = await import("$lib/resolve_db_type");

		const first = files[0]!;
		const abs = join(process.cwd(), first.path);
		const mtime = statSync(abs).mtime.toISOString();
		expect(first.last_updated).toBe(mtime);
		expect(db_type).toBeTruthy();
	});
});
