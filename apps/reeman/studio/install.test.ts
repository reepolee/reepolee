import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { install_studio, type StudioInstallerDatabase } from "./install";

const temp_dirs: string[] = [];

afterEach(() => {
	for (const temp_dir of temp_dirs) {
		if (existsSync(temp_dir)) { rmSync(temp_dir, { recursive: true, force: true }); }
	}
	temp_dirs.length = 0;
});

describe("install_studio", () => {
	test("runs SQLite translations", async () => {
		const fixture = await make_fixture("sqlite");
		const executed_sql: string[] = [];
		const database = make_database(executed_sql);

		await install_studio({
			connection_string: "sqlite:app.db",
			database,
			module_root: fixture.module_root,
		});

		expect(executed_sql).toEqual(["SELECT 'en';\n", "SELECT 'sl';\n"]);
	});

	test("selects MySQL translation files from the connection string", async () => {
		const fixture = await make_fixture("mysql");
		const executed_sql: string[] = [];
		const database = make_database(executed_sql);

		await install_studio({
			connection_string: "mysql://user:pass@localhost/app",
			database,
			module_root: fixture.module_root,
		});

		expect(executed_sql).toEqual(["SELECT 'en';\n", "SELECT 'sl';\n"]);
	});
});

async function make_fixture(dialect: "mysql" | "sqlite"): Promise<{ module_root: string; }> {
	const fixture_root = mkdtempSync(join(tmpdir(), "reepolee-studio-install-"));
	temp_dirs.push(fixture_root);
	const module_root = join(fixture_root, "module");
	const sql_dir = join(module_root, "sql", dialect);
	mkdirSync(sql_dir, { recursive: true });
	await Bun.write(join(sql_dir, "02-init-translations-en-us.sql"), "SELECT 'en';\n");
	await Bun.write(join(sql_dir, "03-init-translations-sl-si.sql"), "SELECT 'sl';\n");
	return { module_root };
}

function make_database(executed_sql: string[]): StudioInstallerDatabase {
	return {
		execute: async (sql) => { executed_sql.push(sql); },
		close: async () => {},
	};
}
