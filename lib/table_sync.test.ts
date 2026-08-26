import { beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";

import { sync_table } from "./table_sync";

const db = new SQL("sqlite::memory:");

beforeAll(async () => {
	await db.unsafe(`CREATE TABLE widgets (
		id INTEGER PRIMARY KEY,
		external_id TEXT,
		title TEXT,
		price INTEGER,
		UNIQUE(external_id)
	)`);
});

describe("sync_table", () => {
	test("inserts new rows and reports the count", async () => {
		await db.unsafe("DELETE FROM widgets");
		let calls = 0;
		const result = await sync_table({
			table: "widgets",
			key_column: "external_id",
			columns: ["title", "price"],
			db,
			fetch_rows: async () => {
				calls++;
				return [
					{ id: "a", name: "Wrench", cost: 10 },
					{ id: "b", name: "Hammer", cost: 20 },
				];
			},
			reshape: (raw) => ({
				external_id: String(raw.id),
				title: String(raw.name),
				price: Number(raw.cost),
			}),
		});

		expect(result).toEqual({ inserted: 2, updated: 0 });
		expect(calls).toBe(1);
		const rows = (await db.unsafe("SELECT external_id, title, price FROM widgets ORDER BY external_id")) as { external_id: string; title: string; price: number }[];
		expect(rows).toEqual([
			{ external_id: "a", title: "Wrench", price: 10 },
			{ external_id: "b", title: "Hammer", price: 20 },
		]);
	});

	test("updates existing rows on re-sync (idempotent)", async () => {
		// Seed one row, then sync with a changed title + one new row.
		await db.unsafe("DELETE FROM widgets");
		await db.unsafe("INSERT INTO widgets (external_id, title, price) VALUES ('a', 'Wrench', 10)");

		const result = await sync_table({
			table: "widgets",
			key_column: "external_id",
			columns: ["title", "price"],
			db,
			fetch_rows: async () => [
				{ id: "a", name: "Wrench 2.0", cost: 12 },
				{ id: "b", name: "Hammer", cost: 20 },
			],
			reshape: (raw) => ({
				external_id: String(raw.id),
				title: String(raw.name),
				price: Number(raw.cost),
			}),
		});

		expect(result).toEqual({ inserted: 1, updated: 1 });
		const rows = (await db.unsafe("SELECT external_id, title, price FROM widgets ORDER BY external_id")) as { external_id: string; title: string; price: number }[];
		expect(rows).toEqual([
			{ external_id: "a", title: "Wrench 2.0", price: 12 },
			{ external_id: "b", title: "Hammer", price: 20 },
		]);
	});

	test("applies the dedupe hook after reshape", async () => {
		await db.unsafe("DELETE FROM widgets");
		const result = await sync_table({
			table: "widgets",
			key_column: "external_id",
			columns: ["title", "price"],
			db,
			fetch_rows: async () => [
				{ id: "a", name: "Wrench", cost: 10 },
				{ id: "a", name: "Wrench", cost: 10 },
				{ id: "b", name: "Hammer", cost: 20 },
			],
			reshape: (raw) => ({
				external_id: String(raw.id),
				title: String(raw.name),
				price: Number(raw.cost),
			}),
			dedupe: (rows) => {
				const seen = new Set<string>();
				return rows.filter((row) => {
					if (seen.has(row.external_id as string)) return false;
					seen.add(row.external_id as string);
					return true;
				});
			},
		});

		expect(result).toEqual({ inserted: 2, updated: 0 });
	});
});
