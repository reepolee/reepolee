import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { project_declares_reset } from "./db_snapshot";
import type { Qa_project } from "./project_store";

function make_project(path: string): Qa_project {
	return { id: "test", name: "Test", path, base_url: "http://127.0.0.1:3110", created_at: new Date().toISOString() };
}

describe("project_declares_reset", () => {
	test("is false when the project has no package.json", async () => {
		const dir = mkdtempSync("/tmp/reeqa-db-snapshot-");
		try {
			expect(await project_declares_reset(make_project(dir))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is false when db:clone-test is absent from scripts", async () => {
		const dir = mkdtempSync("/tmp/reeqa-db-snapshot-");
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "bun server.ts" } }));
			expect(await project_declares_reset(make_project(dir))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is true when db:clone-test is declared", async () => {
		const dir = mkdtempSync("/tmp/reeqa-db-snapshot-");
		try {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "db:clone-test": "bun scripts/clone_db.ts" } }));
			expect(await project_declares_reset(make_project(dir))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
