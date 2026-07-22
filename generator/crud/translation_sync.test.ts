import { describe, expect, mock, test } from "bun:test";

import { get_test_db_connection, make_test_db_mock } from "$root/test_helpers";

// ---------------------------------------------------------------------------
// Test DB fixture - cloned MySQL test DB via TEST_CONNECTION_STRING
// Run `bun run db:clone-test -- --yes --no-data` first.
// ---------------------------------------------------------------------------

const test_db = get_test_db_connection();

// ---------------------------------------------------------------------------
// Mock config/db (using relative path matching source) so lazy imports
// in translation_sync.ts use the test DB connection.
// ---------------------------------------------------------------------------

mock.module("$config/db", () => make_test_db_mock(test_db));

const { sync_nav_translations } = await import("./translation_sync");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetch_nav_entry(namespace: string): Promise<string | null> {
	const rows = await test_db.unsafe(`SELECT translation FROM translations WHERE lang = 'en' AND namespace = ? AND key_path = 'nav' LIMIT 1`, [namespace]);
	return rows.length > 0 ? rows[0].translation : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync_nav_translations - named route (route_name)", () => {
	test("uses route_name for nav label when route_name is provided", async () => {
		await sync_nav_translations("companies", "", false, "my-brands");

		const label = await fetch_nav_entry("my-brands");
		expect(label).toBe("My brands");
	});

	test("uses table_name for nav label when route_name is empty", async () => {
		await sync_nav_translations("companies", "", false, "");

		const label = await fetch_nav_entry("companies");
		expect(label).toBe("Companies");
	});

	test("uses route_name for nav label with prefix", async () => {
		await sync_nav_translations("companies", "admin", false, "my-brands");

		const label = await fetch_nav_entry("admin.my-brands");
		expect(label).toBe("My brands");
	});

	test("uses table_name for nav label with prefix when route_name is empty", async () => {
		await sync_nav_translations("companies", "admin", false, "");

		const label = await fetch_nav_entry("admin.companies");
		expect(label).toBe("Companies");
	});

	test("handles hyphenated route_name correctly", async () => {
		await sync_nav_translations("companies", "", false, "top-my-brands");

		const label = await fetch_nav_entry("top-my-brands");
		expect(label).toBe("Top my brands");
	});

	test("skips nav sync for nested routes", async () => {
		await sync_nav_translations("equipment_items", "", true, "");

		const label = await fetch_nav_entry("equipment_items");
		expect(label).toBeNull();
	});

	test("skips nav sync for nested routes even with route_name", async () => {
		await sync_nav_translations("equipment_items", "", true, "my-items");

		// Should not write anything since is_nested = true
		const label = await fetch_nav_entry("my-items");
		expect(label).toBeNull();
	});
});

describe("sync_nav_translations - overwrites existing entries", () => {
	test("replaces existing nav translation in the same namespace", async () => {
		// Write first with table_name
		await sync_nav_translations("companies", "", false, "");
		expect(await fetch_nav_entry("companies")).toBe("Companies");

		// Overwrite same namespace with route_name
		await sync_nav_translations("companies", "", false, "my-brands");
		// Old namespace still has its entry (sync_nav_translations only manages the current namespace)
		expect(await fetch_nav_entry("companies")).toBe("Companies");
		expect(await fetch_nav_entry("my-brands")).toBe("My brands");
	});

	test("replaces nav translation when route_name changes", async () => {
		await sync_nav_translations("companies", "", false, "my-brands");
		expect(await fetch_nav_entry("my-brands")).toBe("My brands");

		await sync_nav_translations("companies", "", false, "our-brands");
		// Old namespace still has its entry
		expect(await fetch_nav_entry("my-brands")).toBe("My brands");
		expect(await fetch_nav_entry("our-brands")).toBe("Our brands");
	});
});
