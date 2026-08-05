/**
 * Write fan-out across locale clones.
 *
 * The important property here is atomicity: a fan-out touches N tables, so a
 * failure partway through must leave nothing behind. Without that, one locale
 * holds a row the others do not - the exact inconsistency the clone model
 * exists to prevent.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";

mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si", "de-at"],
	active_locales: ["en-us", "sl-si", "de-at"],
	default_locale: "en-us",
	locale_names: {},
	locale_aliases: {},
}));

// locale_write.ts binds `db` at import time, so the connection has to exist
// before the module is loaded. One in-memory database is reused across tests
// and its tables are recreated in beforeEach.
const db = new SQL("sqlite://:memory:");

mock.module("$config/db", () => ({ db }));
mock.module("$lib/cache", () => ({ cache: { invalidate: async () => {} } }));

const { fan_out_create, fan_out_delete, fan_out_update, save_locale_values } = await import("./locale_write");

const FAN_OUT = {
	table_name: "frameworks",
	localized_columns: ["name", "tagline"],
	write_columns: ["name", "tagline", "developer_id"],
};

async function make_table(name: string): Promise<void> {
	await db.unsafe(`CREATE TABLE ${name} (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		tagline TEXT,
		developer_id INTEGER,
		name_src TEXT,
		name_hash TEXT,
		tagline_src TEXT,
		tagline_hash TEXT
	)`);
}

beforeEach(async () => {
	for (const table of ["frameworks", "frameworks_sl_si", "frameworks_de_at"]) {
		await db.unsafe(`DROP TABLE IF EXISTS ${table}`);
		await make_table(table);
	}
	await db.unsafe(`INSERT INTO frameworks (id, name, tagline, developer_id) VALUES (1, 'Base', 'Base tagline', 7)`);
});

async function count(table: string): Promise<number> {
	const rows = (await db.unsafe(`SELECT COUNT(*) AS c FROM ${table}`)) as any[];
	return Number(rows[0].c);
}

async function row(table: string, id: number): Promise<any> {
	const rows = (await db.unsafe(`SELECT * FROM ${table} WHERE id = ?`, [id])) as any[];
	return rows[0];
}

describe("fan_out_create", () => {
	test("clones the base row into every non-default locale with the same id", async () => {
		await fan_out_create(FAN_OUT, 1, { name: "Base", tagline: "Base tagline", developer_id: 7 });
		expect((await row("frameworks_sl_si", 1)).name).toBe("Base");
		expect((await row("frameworks_de_at", 1)).name).toBe("Base");
	});

	test("writes nothing when a clone insert fails partway through", async () => {
		// de-at already holds this id, so the second insert of the fan-out is
		// rejected and the first must roll back with it.
		await db.unsafe(`INSERT INTO frameworks_de_at (id, name) VALUES (1, 'existing')`);

		await expect(fan_out_create(FAN_OUT, 1, { name: "Base", tagline: "t", developer_id: 7 })).rejects.toThrow();

		expect(await count("frameworks_sl_si")).toBe(0);
	});
});

describe("fan_out_update", () => {
	beforeEach(async () => {
		await fan_out_create(FAN_OUT, 1, { name: "Base", tagline: "Base tagline", developer_id: 7 });
	});

	test("writes localized columns only to the edited locale", async () => {
		await fan_out_update(FAN_OUT, 1, { name: "Slovenско", tagline: "SL", developer_id: 7 }, "sl-si");

		expect((await row("frameworks_sl_si", 1)).name).toBe("Slovenско");
		// The other locales keep their own translations.
		expect((await row("frameworks_de_at", 1)).name).toBe("Base");
		expect((await row("frameworks", 1)).name).toBe("Base");
	});

	test("writes shared columns to every locale so they cannot drift", async () => {
		await fan_out_update(FAN_OUT, 1, { name: "SL", tagline: "SL", developer_id: 99 }, "sl-si");

		expect((await row("frameworks", 1)).developer_id).toBe(99);
		expect((await row("frameworks_sl_si", 1)).developer_id).toBe(99);
		expect((await row("frameworks_de_at", 1)).developer_id).toBe(99);
	});

	test("editing the default locale writes its localized columns to the base table", async () => {
		await fan_out_update(FAN_OUT, 1, { name: "English", tagline: "EN", developer_id: 7 }, "en-us");
		expect((await row("frameworks", 1)).name).toBe("English");
		expect((await row("frameworks_sl_si", 1)).name).toBe("Base");
	});
});

describe("fan_out_delete", () => {
	beforeEach(async () => {
		await fan_out_create(FAN_OUT, 1, { name: "Base", tagline: "Base tagline", developer_id: 7 });
	});

	test("removes the record from every physical table", async () => {
		const affected = await fan_out_delete("frameworks", 1);
		expect(affected).toBeGreaterThan(0);
		expect(await count("frameworks")).toBe(0);
		expect(await count("frameworks_sl_si")).toBe(0);
		expect(await count("frameworks_de_at")).toBe(0);
	});
});

describe("save_locale_values", () => {
	beforeEach(async () => {
		await fan_out_create(FAN_OUT, 1, { name: "Base", tagline: "Base tagline", developer_id: 7 });
	});

	test("writes each locale's submitted values to its own row", async () => {
		await save_locale_values("frameworks", 1, {
			"sl-si": { name: "Slovensko" },
			"de-at": { name: "Deutsch" },
		});

		expect((await row("frameworks_sl_si", 1)).name).toBe("Slovensko");
		expect((await row("frameworks_de_at", 1)).name).toBe("Deutsch");
	});

	test("clears provenance for a hand-edited field - it is no longer a copy", async () => {
		await db.unsafe(`UPDATE frameworks_sl_si SET name_src = 'en-us', name_hash = 'abc' WHERE id = 1`);

		await save_locale_values("frameworks", 1, { "sl-si": { name: "Typed by hand" } });

		const updated = await row("frameworks_sl_si", 1);
		expect(updated.name).toBe("Typed by hand");
		expect(updated.name_src).toBeNull();
		expect(updated.name_hash).toBeNull();
	});
});
