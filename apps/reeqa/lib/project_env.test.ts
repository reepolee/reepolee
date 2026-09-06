import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse_env_file, read_project_env } from "./project_env";
import type { Qa_project } from "./project_store";

function make_project(path: string): Qa_project {
	return { id: "test", name: "Test", path, base_url: "http://127.0.0.1:3110", created_at: new Date().toISOString() };
}

describe("parse_env_file", () => {
	test("reads simple assignments", () => {
		expect(parse_env_file("ADMIN_USERNAME=admin\nADMIN_PASSWORD=secret")).toEqual({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret" });
	});

	test("skips blank lines and comments", () => {
		expect(parse_env_file("\n# a comment\n\nADMIN_USERNAME=admin\n")).toEqual({ ADMIN_USERNAME: "admin" });
	});

	test("strips an export prefix", () => {
		expect(parse_env_file("export ADMIN_USERNAME=admin")).toEqual({ ADMIN_USERNAME: "admin" });
	});

	test("strips surrounding quotes", () => {
		expect(parse_env_file(`ADMIN_USERNAME="admin"\nADMIN_PASSWORD='secret'`)).toEqual({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret" });
	});

	test("keeps everything after the first = as the value", () => {
		expect(parse_env_file("CONNECTION_STRING=mysql://user:pass@host/db?x=1")).toEqual({ CONNECTION_STRING: "mysql://user:pass@host/db?x=1" });
	});

	test("skips malformed names", () => {
		expect(parse_env_file("1INVALID=x\nVALID_NAME=y")).toEqual({ VALID_NAME: "y" });
	});

	test("skips lines with no =", () => {
		expect(parse_env_file("not-an-assignment\nADMIN_USERNAME=admin")).toEqual({ ADMIN_USERNAME: "admin" });
	});
});

describe("read_project_env", () => {
	test("is empty when the project has no .env", async () => {
		const dir = mkdtempSync("/tmp/reeqa-project-env-");
		try {
			expect(await read_project_env(make_project(dir))).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reads the project's .env file", async () => {
		const dir = mkdtempSync("/tmp/reeqa-project-env-");
		try {
			writeFileSync(join(dir, ".env"), "ADMIN_USERNAME=admin\nADMIN_PASSWORD=secret\n");
			expect(await read_project_env(make_project(dir))).toEqual({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
