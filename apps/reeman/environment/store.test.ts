import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env_var_description } from "$config/env_var_descriptions";

import { delete_items, get_all_items, get_item_by_id, search_items, update_item } from "./store";

const temporary_directories: string[] = [];

async function create_project(env_content: string, example_content: string): Promise<string> {
	const project_root = await mkdtemp(join(tmpdir(), "reepolee-environment-store-"));
	temporary_directories.push(project_root);
	await Bun.write(`${project_root}/.env`, env_content);
	await Bun.write(`${project_root}/.env.example`, example_content);
	return project_root;
}

afterEach(async () => {
	for (const directory of temporary_directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("environment store", () => {
	test("reads active entries from .env, with descriptions from code", async () => {
		const project_root = await create_project(
			"FIRST=one\n# SECOND=ignored\nexport SECOND=\"two\"\nPORT=2338\n",
			"# Descriptions no longer come from here.\nFIRST=default\n",
		);

		const records = await get_all_items(project_root);

		// FIRST and SECOND are not real variables, so they carry no description.
		// PORT is in the committed inventory and gets its text from
		// config/env_var_descriptions.ts - never from .env.example.
		expect(records).toEqual([
			{ id: "FIRST", key: "FIRST", value: "one", description: "", edit_url: "/environment/FIRST/edit" },
			{ id: "SECOND", key: "SECOND", value: "\"two\"", description: "", edit_url: "/environment/SECOND/edit" },
			{ id: "PORT", key: "PORT", value: "2338", description: env_var_description("PORT"), edit_url: "/environment/PORT/edit" },
		]);
	});

	test("descriptions survive a project with no .env.example at all", async () => {
		const project_root = await mkdtemp(join(tmpdir(), "reepolee-environment-store-"));
		temporary_directories.push(project_root);
		await Bun.write(`${project_root}/.env`, "PORT=2338\n");

		const records = await get_all_items(project_root);

		expect(records[0]?.description).toBe(env_var_description("PORT"));
		expect(records[0]?.description).not.toBe("");
	});

	test("updates a value without changing surrounding content or line endings", async () => {
		const project_root = await create_project("# Keep\r\nFIRST = old\r\nSECOND=stay\r\n", "FIRST=\nSECOND=\n");

		expect(await update_item("FIRST", "new=value", project_root)).toBe(true);
		expect(await Bun.file(`${project_root}/.env`).text()).toBe("# Keep\r\nFIRST =new=value\r\nSECOND=stay\r\n");
		expect(await update_item("MISSING", "value", project_root)).toBe(false);
	});

	test("rejects multiline values", async () => {
		const project_root = await create_project("FIRST=one\n", "FIRST=\n");

		expect(update_item("FIRST", "one\ntwo", project_root)).rejects.toThrow("one line");
	});

	test("deletes selected keys and preserves other lines", async () => {
		const project_root = await create_project("# Keep\nFIRST=one\nSECOND=two\nFIRST=duplicate\n", "FIRST=\nSECOND=\n");

		expect(await delete_items(["FIRST", "missing"], project_root)).toBe(1);
		expect(await Bun.file(`${project_root}/.env`).text()).toBe("# Keep\nSECOND=two\n");
	});

	test("searches, sorts, paginates, and finds by key", async () => {
		const project_root = await create_project("ZED=last\nALPHA=first\nBETA=middle\n", "# Match me\nALPHA=\nBETA=\nZED=\n");

		const result = await search_items("", 1, 1, "key::asc", project_root);
		expect(result.total).toBe(3);
		expect(result.items[0]?.key).toBe("BETA");
		expect((await get_item_by_id("ZED", project_root))?.value).toBe("last");
	});

	test("keeps the native .env order by default", async () => {
		const project_root = await create_project("ZED=last\nALPHA=first\nBETA=middle\n", "ZED=\nALPHA=\nBETA=\n");

		const result = await search_items("", 0, 20, undefined, project_root);
		const keys = result.items.map((item) => item.key);
		expect(keys).toEqual(["ZED", "ALPHA", "BETA"]);
	});
});
