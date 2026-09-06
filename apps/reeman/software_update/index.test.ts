/**
 * Functional tests for the Reesync routes - real filesystem, real snapshot
 * files under temporary directories, no browser/render() dependency
 * (every handler exercised here either redirects or returns a plain
 * Response, so none of them touch the .ree template engine).
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BunRequest } from "bun";

import { get_software_update_browse, get_software_update_diff, group_by_folder, post_software_update_apply, post_software_update_ignore, post_software_update_scan, software_update_crud, type Software_update_runtime } from "./index";
import { save_snapshot } from "./lib/snapshot";
import type { ScanSnapshot } from "./lib/types";
import { diff_directories } from "./lib/diff";

// Route handlers accept runtime storage overrides so these functional tests
// never write snapshots, busy state, or run records into the checkout.

function fake_req(opts: { url: string; method?: string; body?: string; headers?: Record<string, string> }): BunRequest {
	const headers = new Map(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	return {
		url: opts.url,
		method: opts.method ?? "GET",
		headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
		text: async () => opts.body ?? "",
	} as unknown as BunRequest;
}

function make_runtime(base: string): Required<Software_update_runtime> {
	return {
		snapshot_dir: join(base, "snapshots"),
		run_log_file: join(base, "runs.json"),
		busy_file: join(base, "busy.json"),
		last_source_file: join(base, "last-source.json"),
	};
}

test("groups scan entries into a collapsible directory tree", () => {
	const entry: ScanSnapshot["entries"][number] = {
		rel_path: "apps/reeman/software_update/index.ts",
		state: "modified",
		source_hash: "source",
		dest_hash: "dest",
		source_size: 1,
		dest_size: 1,
		commit_info: null,
		ignored: false,
		ignore_pattern: null,
		is_exact_ignore: false,
	};

	const groups = group_by_folder([entry]);
	expect(groups.map((group) => group.folder)).toEqual(["apps", "apps/reeman", "apps/reeman/software_update"]);
	expect(groups.find((group) => group.folder === "apps/reeman")?.parent).toBe("apps");
	expect(groups.find((group) => group.folder === "apps/reeman/software_update")?.entries).toEqual([entry]);
});

test("registers and serves the upstream folder browser endpoint", async () => {
	const browse_route = software_update_crud["/software-update/browse"];
	expect(browse_route?.GET).toBe(get_software_update_browse);

	const response = await get_software_update_browse(fake_req({ url: "http://localhost/software-update/browse" }));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(expect.objectContaining({ dirs: expect.any(Array), project_root: expect.any(String) }));
});

async function make_project(): Promise<{ source: string; project: string; runtime: Required<Software_update_runtime>; cleanup: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "reesync-functional-"));
	const source = join(base, "source");
	const project = join(base, "project");
	const runtime = make_runtime(base);
	await mkdir(source, { recursive: true });
	await mkdir(project, { recursive: true });
	return { source, project, runtime, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function build_snapshot(source: string, project: string, snapshot_dir: string): Promise<ScanSnapshot> {
	const entries = await diff_directories(source, project);
	const snapshot: ScanSnapshot = {
		scan_id: `test-${Math.random().toString(36).slice(2, 10)}`,
		source_root: source,
		project_root: project,
		created_at: new Date().toISOString(),
		entries,
	};
	await save_snapshot(snapshot, snapshot_dir);
	return snapshot;
}

describe("post_software_update_scan", () => {
	// The invalid-source path calls get_software_update_page(), which renders a .ree
	// template - that needs the full app bootstrap (template engine, mounted
	// route modules) and isn't exercised at this level. validate_source_dir's
	// rejection branches are covered directly in lib/paths.test.ts instead.

	// Scans and hashes the whole reepolee checkout (including the marketplace
	// tarballs and static assets), so it needs a generous timeout under
	// --parallel load instead of Bun's 5s default.
	test("scans a real temp source directory against this project and redirects to the review page", async () => {
		const base = await mkdtemp(join(dirname(process.cwd()), "reesync-scan-"));
		const runtime = make_runtime(base);
		try {
			await writeFile(join(base, "upstream-only.txt"), "hello");

			const req = fake_req({ url: "http://localhost/software-update/scan", method: "POST", body: `source_dir=${encodeURIComponent(base)}` });
			const res = await post_software_update_scan(req, runtime);

			expect(res.status).toBe(303);
			const location = res.headers.get("Location")!;
			// Routes are locale-aliased, so the redirect is "/software-update" or
			// "/en-us/software-update" depending on the active locale config. Ten test files
			// mock $config/supported_locales, and mock.module is process-global in
			// Bun, so which form this route produces depends on what else ran
			// first. The property under test is the destination and the scan id,
			// not the locale prefix.
			expect(location).toMatch(/^(\/[a-z]{2}-[a-z]{2})?\/software-update\?scan=/);
			const scan_id = new URL(location, "http://localhost").searchParams.get("scan")!;

			const { load_snapshot, delete_snapshot } = await import("./lib/snapshot");
			const snapshot = await load_snapshot(scan_id, runtime.snapshot_dir);
			expect(snapshot).not.toBeNull();
			expect(snapshot!.entries.some((e) => e.rel_path === "upstream-only.txt" && e.state === "new")).toBe(true);
			expect(JSON.parse(await readFile(runtime.last_source_file, "utf8"))).toEqual({ path: base });
			await delete_snapshot(scan_id, runtime.snapshot_dir);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	}, { timeout: 60_000 });
});

describe("software update ignore + apply + diff (isolated snapshot)", () => {
	test("full flow: scan snapshot, ignore toggle, lazy diff, then apply", async () => {
		const { source, project, runtime, cleanup } = await make_project();
		try {
			await writeFile(join(source, "new.txt"), "hello upstream");
			await writeFile(join(source, "changed.txt"), "upstream v2");
			await writeFile(join(project, "changed.txt"), "local v1");

			const snapshot = await build_snapshot(source, project, runtime.snapshot_dir);

			// --- lazy diff endpoint ---
			const diff_req = fake_req({ url: `http://localhost/software-update/diff?scan=${snapshot.scan_id}&path=changed.txt` });
			const diff_res = await get_software_update_diff(diff_req, runtime);
			const diff_html = await diff_res.text();
			expect(diff_html).toContain("upstream v2");
			expect(diff_html).toContain("local v1");

			// --- ignore toggle: add then remove an exact entry ---
			const ignore_add_req = fake_req({
				url: "http://localhost/software-update/ignore",
				method: "POST",
				body: `scan=${snapshot.scan_id}&rel_path=new.txt&ignore_action=add`,
			});
			const ignore_res = await post_software_update_ignore(ignore_add_req, runtime);
			expect(ignore_res.status).toBe(303);
			const ignore_list_text = await readFile(join(project, ".reesyncignore"), "utf8");
			expect(ignore_list_text).toContain("new.txt");

			// The ignore handler rescans and issues a fresh scan id in the redirect.
			const redirected_scan_id = new URL(ignore_res.headers.get("Location")!, "http://localhost").searchParams.get("scan")!;
			expect(redirected_scan_id).not.toBe(snapshot.scan_id);

			// --- apply: only changed.txt should copy; new.txt stays ignored ---
			const apply_req = fake_req({
				url: "http://localhost/software-update/apply",
				method: "POST",
				body: `scan=${redirected_scan_id}&selected=changed.txt&selected=new.txt`,
			});
			const apply_res = await post_software_update_apply(apply_req, runtime);
			expect(apply_res.status).toBe(303);

			expect(await readFile(join(project, "changed.txt"), "utf8")).toBe("upstream v2");
			const runs = JSON.parse(await readFile(runtime.run_log_file, "utf8")) as { action: string }[];
			expect(runs[0]?.action).toBe("software_update_apply");
			// new.txt was ignored at apply time, so it must not have been created.
			await expect(readFile(join(project, "new.txt"), "utf8")).rejects.toThrow();
		} finally {
			await cleanup();
		}
	});

	test("apply rejects a file changed on disk after scan (stale-checked)", async () => {
		const { source, project, runtime, cleanup } = await make_project();
		try {
			await writeFile(join(source, "a.txt"), "v1");
			const snapshot = await build_snapshot(source, project, runtime.snapshot_dir);
			await writeFile(join(source, "a.txt"), "v2 - changed after scan");

			const apply_req = fake_req({
				url: "http://localhost/software-update/apply",
				method: "POST",
				body: `scan=${snapshot.scan_id}&selected=a.txt`,
			});
			const apply_res = await post_software_update_apply(apply_req, runtime);
			expect(apply_res.status).toBe(303);
			await expect(readFile(join(project, "a.txt"), "utf8")).rejects.toThrow();
		} finally {
			await cleanup();
		}
	});
});
