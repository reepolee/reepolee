import { afterEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";

import { make_test_db_mock } from "$root/test_helpers";

const test_db = new SQL(":memory:");
await test_db.unsafe(`CREATE TABLE metrics (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL)`);
await test_db.unsafe(`CREATE TABLE metrics_sl_si (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, name_src TEXT, name_hash TEXT)`);
await test_db.unsafe(`INSERT INTO metrics (id, code, name) VALUES (1, 'metric-1', 'English name')`);
await test_db.unsafe(`INSERT INTO metrics_sl_si (id, code, name, name_src, name_hash) VALUES (1, 'metric-1', 'Old Slovenian name', 'en-us', 'old-hash')`);

mock.module("$config/db", () => make_test_db_mock(test_db));
mock.module("$config/supported_locales", () => ({
	default_locale: "en-us",
	locales: ["en-us", "sl-si"],
	active_locales: ["en-us", "sl-si"],
	locale_names: { "en-us": "English", "sl-si": "Slovenian" },
}));

const { fan_out_update, save_locale_values } = await import("./locale_write");

async function row(table: string): Promise<{ code: string; name: string; name_src?: string | null; name_hash?: string | null; }> {
	const columns = table === "metrics" ? "code, name" : "code, name, name_src, name_hash";
	const rows = await test_db.unsafe(`SELECT ${columns} FROM ${table} WHERE id = 1`);
	return rows[0] as any;
} afterEach(async () => {
	await test_db.unsafe("UPDATE metrics SET code = 'metric-1', name = 'English name' WHERE id = 1");
	await test_db.unsafe("UPDATE metrics_sl_si SET code = 'metric-2', name = 'Old Slovenian name', name_src = 'en-us', name_hash = 'old-hash' WHERE id = 1");
});

describe("locale writes", () => {
	test("updates the edited locale and preserves the other locale before/after", async () => {
		const before_base = await row("metrics");
		const before_sl = await row("metrics_sl_si");

		await fan_out_update(
			{
				table_name: "metrics",
				localized_columns: ["name"],
				write_columns: ["code", "name"],
				protected_columns: ["sensor_code"],
			},
			1,
			{ code: "metric-2", name: "New Slovenian name" },
			"sl-si",
		);
		await save_locale_values("metrics", 1, { "sl-si": { name: "New Slovenian name" } }, ["code"]);

		const after_base = await row("metrics");
		const after_sl = await row("metrics_sl_si");

		expect(before_base.code).toBe("metric-1");
		expect(before_sl.name).toBe("Old Slovenian name");
		expect(after_base.code).toBe("metric-2");
		expect(after_base.name).toBe("English name");
		expect(after_sl.code).toBe("metric-2");
		expect(after_sl.name).toBe("New Slovenian name");
		expect(after_sl.name_src).toBe("en-us");
		expect(after_sl.name_hash).toBe("old-hash");
	});

	test("saves a changed shared code value to the base and locale rows", async () => {
		await test_db.unsafe("UPDATE metrics SET code = 'metric-1', name = 'English name' WHERE id = 1");
		await test_db.unsafe("UPDATE metrics_sl_si SET code = 'metric-1', name = 'Old Slovenian name', name_src = 'en-us', name_hash = 'old-hash' WHERE id = 1");
		const before_base = await row("metrics");
		const before_sl = await row("metrics_sl_si");
		expect(before_base.code).toBe("metric-1");
		expect(before_sl.code).toBe("metric-1");

		await fan_out_update(
			{
				table_name: "metrics",
				localized_columns: ["name"],
				write_columns: ["code", "name"],
				protected_columns: ["sensor_code"],
			},
			1,
			{ code: "metric-changed", name: "English name" },
			"sl-si",
		);

		const after_base = await row("metrics");
		const after_sl = await row("metrics_sl_si");
		expect(after_base.code).toBe("metric-changed");
		expect(after_sl.code).toBe("metric-changed");
	});

	test("does not update columns excluded from update_columns", async () => {
		await fan_out_update(
			{
				table_name: "metrics",
				localized_columns: ["name"],
				write_columns: ["code", "name"],
				update_columns: ["name"],
			},
			1,
			{ code: "metric-changed", name: "Updated name" },
			"en-us",
		);

		const base = await row("metrics");
		expect(base.code).toBe("metric-1");
		expect(base.name).toBe("Updated name");
	});
});
