import { describe, expect, test } from "bun:test";
import { SQL } from "bun";

import { import_d1_table } from "./d1_import";

const d1_config = { api_token: "token-1", account_id: "acct-1", database_id: "db-1" };

describe("import_d1_table", () => {
	test("fetches a D1 table, reshapes rows, and upserts the target table", async () => {
		const db = new SQL("sqlite::memory:");
		await db.unsafe("CREATE TABLE teams (external_id TEXT UNIQUE, name TEXT, members INTEGER)");
		let sent_sql = "";
		const fetch_fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const request_body = JSON.parse(String(init?.body)) as { sql: string };
			sent_sql = request_body.sql;
			return new Response(JSON.stringify({
				success: true,
				errors: [],
				result: [{ success: true, results: [{ id: "a", team_name: "Brick Masters", member_count: "4" }] }],
			}));
		};

		const result = await import_d1_table({
			db,
			table: "teams",
			key_column: "external_id",
			columns: ["name", "members"],
			source_table: "registrations",
			d1_config,
			fetch_fn,
			reshape: (row) => ({
				external_id: String(row.id),
				name: String(row.team_name),
				members: Number(row.member_count),
			}),
		});

		expect(sent_sql).toBe("SELECT * FROM \"registrations\"");
		expect(result).toEqual({ inserted: 1, updated: 0 });
		const rows = await db.unsafe("SELECT external_id, name, members FROM teams");
		expect(rows).toEqual([{ external_id: "a", name: "Brick Masters", members: 4 }]);
		await db.close();
	});

	test("passes source_sql parameters to D1", async () => {
		const db = new SQL("sqlite::memory:");
		await db.unsafe("CREATE TABLE teams (external_id TEXT UNIQUE, name TEXT)");
		let sent_body: { sql: string; params: unknown[] } | undefined;
		const fetch_fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			sent_body = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] };
			return new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: [] }] }));
		};

		await import_d1_table({
			db,
			table: "teams",
			key_column: "external_id",
			columns: ["name"],
			source_sql: "SELECT * FROM registrations WHERE status = ?",
			source_params: ["active"],
			d1_config,
			fetch_fn,
			reshape: () => ({ external_id: "unused", name: "unused" }),
		});

		expect(sent_body).toEqual({ sql: "SELECT * FROM registrations WHERE status = ?", params: ["active"] });
		await db.close();
	});

	test("fails clearly when the D1 source or credentials are not configured", async () => {
		const db = new SQL("sqlite::memory:");
		await db.unsafe("CREATE TABLE teams (external_id TEXT UNIQUE, name TEXT)");
		const base_options = { db, table: "teams", key_column: "external_id", columns: ["name"], reshape: () => ({ external_id: "a", name: "A" }) };

		await expect(import_d1_table(base_options)).rejects.toThrow("exactly one of source_table or source_sql");
		await expect(import_d1_table({ ...base_options, source_table: "registrations" })).rejects.toThrow("D1 import is not configured");
		await db.close();
	});
});
