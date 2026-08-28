/**
 * Reesync: selective upstream adoption for a diverged Reepolee project.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { make_toast } from "$lib/cookies";
import { localized_url, resolve_locale } from "$lib/route";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { clear_busy, GLOBAL_BUSY_KEY, set_busy } from "$reeman/reeman/lib/busy_state";
import { record_run } from "$reeman/reeman/lib/state";

import { diff_directories, rehash } from "./lib/diff";
import { add_exact, load_ignore_list, remove_exact } from "./lib/ignore_list";
import { read_last_source, write_last_source } from "./lib/last_source";
import { is_contained, is_sibling, validate_source_dir } from "./lib/paths";
import { delete_snapshot, find_entry, generate_scan_id, load_snapshot, prune_expired_snapshots, save_snapshot } from "./lib/snapshot";
import { apply_software_update } from "./lib/software_update";
import { build_diff, build_preview } from "./lib/text_diff";
import type { ScanEntry, ScanSnapshot, ScanSummary } from "./lib/types";

const BASE_PATH = "/software-update";
const PROJECT_ROOT = process.cwd();

export type Software_update_runtime = {
	snapshot_dir?: string;
	run_log_file?: string;
	busy_file?: string;
	last_source_file?: string;
};

function summarize(entries: ScanEntry[]): ScanSummary {
	let new_count = 0;
	let modified_count = 0;
	let project_only_count = 0;
	let ignored_count = 0;
	let selectable_count = 0;
	for (const entry of entries) {
		if (entry.state === "new") new_count++;
		else if (entry.state === "modified") modified_count++;
		else project_only_count++;
		if (entry.ignored) ignored_count++;
		if (entry.state !== "project-only" && !entry.ignored) selectable_count++;
	}
	return { new_count, modified_count, project_only_count, ignored_count, selectable_count };
}

type Folder_group = {
	folder: string;
	parent: string | null;
	entries: ScanEntry[];
};

export function group_by_folder(entries: ScanEntry[]): Folder_group[] {
	const groups = new Map<string, Folder_group>();
	const ensure_group = (folder: string): Folder_group => {
		const existing = groups.get(folder);
		if (existing) return existing;
		const slash_index = folder.lastIndexOf("/");
		const parent = slash_index === -1 ? null : folder.slice(0, slash_index);
		const group = { folder, parent, entries: [] };
		groups.set(folder, group);
		return group;
	};

	for (const entry of entries) {
		const slash_index = entry.rel_path.lastIndexOf("/");
		const folder = slash_index === -1 ? "" : entry.rel_path.slice(0, slash_index);
		ensure_group(folder).entries.push(entry);

		let parent = folder;
		while (parent) {
			ensure_group(parent);
			const parent_slash_index = parent.lastIndexOf("/");
			parent = parent_slash_index === -1 ? "" : parent.slice(0, parent_slash_index);
		}
	}
	return [...groups.values()].sort((a, b) => a.folder.localeCompare(b.folder));
}

function toast_redirect(req: BunRequest, message: string, type: "green" | "red" | "yellow" = "green", target = BASE_PATH): Response {
	const locale = resolve_locale(req);
	const headers = new Headers({ Location: localized_url(target, locale) });
	headers.append("Set-Cookie", make_toast("toast-software-update", { message, type, duration: 6000 }).toString());
	return new Response(null, { status: 303, headers });
}

async function params_of(req: BunRequest): Promise<URLSearchParams> {
	return new URLSearchParams(await req.text());
}

// ---------------------------------------------------------------------------
// GET /software-update
// ---------------------------------------------------------------------------

export async function get_software_update_page(req: BunRequest, form_error = "", runtime: Software_update_runtime = {}): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const url = new URL(req.url);
	const scan_id = url.searchParams.get("scan") || "";

	const last_source = await read_last_source(runtime.last_source_file);
	const snapshot = scan_id ? await load_snapshot(scan_id, runtime.snapshot_dir) : null;
	const form_error_message = form_error ? (ctx.translations?.errors?.[form_error] ?? form_error) : "";
	const current_source_head = snapshot ? get_git_head(snapshot.source_root) : null;
	const source_changed = Boolean(snapshot?.source_head && current_source_head && snapshot.source_head !== current_source_head);

	if (!snapshot) {
		return render("index", {
			data: {
				form_error: form_error_message,
				last_source,
				snapshot: null,
				scan_id: "",
				summary: summarize([]),
				groups: [],
				source_changed: false,
				expired: Boolean(scan_id),
			},
			ctx,
		});
	}

	const groups = group_by_folder(snapshot.entries);
	return render("index", {
		data: {
			form_error: form_error_message,
			last_source: snapshot.source_root,
			snapshot,
			scan_id: snapshot.scan_id,
			summary: summarize(snapshot.entries),
			groups,
			source_changed,
			expired: false,
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// POST /software-update/scan
// ---------------------------------------------------------------------------

export async function post_software_update_scan(req: BunRequest, runtime: Software_update_runtime = {}): Promise<Response> {
	const params = await params_of(req);
	const raw_source = params.get("source_dir") ?? "";

	const validation = await validate_source_dir(raw_source, PROJECT_ROOT);
	if (!validation.ok) {
		return get_software_update_page(req, `source_${validation.error.replaceAll("-", "_")}`, runtime);
	}

	await prune_expired_snapshots(runtime.snapshot_dir);

	const entries = await diff_directories(validation.canonical, PROJECT_ROOT);
	const snapshot: ScanSnapshot = {
		scan_id: generate_scan_id(),
		source_root: validation.canonical,
		project_root: PROJECT_ROOT,
		source_head: get_git_head(validation.canonical),
		created_at: new Date().toISOString(),
		entries,
	};
	await save_snapshot(snapshot, runtime.snapshot_dir);
	await write_last_source(validation.canonical, runtime.last_source_file);

	const locale = resolve_locale(req);
	return Response.redirect(`${localized_url(BASE_PATH, locale)}?scan=${snapshot.scan_id}`, 303);
}

// ---------------------------------------------------------------------------
// POST /software-update/ignore - toggle an exact .reesyncignore entry, then rescan
// ---------------------------------------------------------------------------

export async function post_software_update_ignore(req: BunRequest, runtime: Software_update_runtime = {}): Promise<Response> {
	const params = await params_of(req);
	const scan_id = params.get("scan") ?? "";
	const rel_path = params.get("rel_path") ?? "";
	const action = params.get("ignore_action") ?? "";

	const snapshot = await load_snapshot(scan_id, runtime.snapshot_dir);
	if (!snapshot) return toast_redirect(req, "Reesync: scan expired. Rescan the source directory.", "red");
	if (!rel_path || (action !== "add" && action !== "remove")) return toast_redirect(req, "Reesync: invalid ignore request.", "red");

	let list = await load_ignore_list(snapshot.project_root);
	list = action === "add" ? await add_exact(list, rel_path) : await remove_exact(list, rel_path);

	const entries = await diff_directories(snapshot.source_root, snapshot.project_root);
	const rescanned: ScanSnapshot = {
		scan_id: generate_scan_id(),
		source_root: snapshot.source_root,
		project_root: snapshot.project_root,
		created_at: new Date().toISOString(),
		entries,
	};
	await save_snapshot(rescanned, runtime.snapshot_dir);
	await delete_snapshot(snapshot.scan_id, runtime.snapshot_dir);

	const locale = resolve_locale(req);
	return Response.redirect(`${localized_url(BASE_PATH, locale)}?scan=${rescanned.scan_id}`, 303);
}

// ---------------------------------------------------------------------------
// POST /software-update/ignore-selected - bulk ignore selected files, then rescan
// ---------------------------------------------------------------------------

export async function post_software_update_ignore_selected(req: BunRequest, runtime: Software_update_runtime = {}): Promise<Response> {
	const params = await params_of(req);
	const scan_id = params.get("scan") ?? "";
	const selected = params.getAll("selected");

	const snapshot = await load_snapshot(scan_id, runtime.snapshot_dir);
	if (!snapshot) return toast_redirect(req, "Reesync: scan expired. Rescan the source directory.", "red");
	if (selected.length === 0) return toast_redirect(req, "Reesync: no files selected to ignore.", "yellow", `${BASE_PATH}?scan=${scan_id}`);

	let list = await load_ignore_list(snapshot.project_root);
	for (const rel_path of selected) {
		list = await add_exact(list, rel_path);
	}

	const entries = await diff_directories(snapshot.source_root, snapshot.project_root);
	const rescanned: ScanSnapshot = {
		scan_id: generate_scan_id(),
		source_root: snapshot.source_root,
		project_root: snapshot.project_root,
		created_at: new Date().toISOString(),
		entries,
	};
	await save_snapshot(rescanned, runtime.snapshot_dir);
	await delete_snapshot(snapshot.scan_id, runtime.snapshot_dir);

	const locale = resolve_locale(req);
	return Response.redirect(`${localized_url(BASE_PATH, locale)}?scan=${rescanned.scan_id}`, 303);
}

// ---------------------------------------------------------------------------
// POST /software-update/apply - stale-checked bounded copy
// ---------------------------------------------------------------------------

export async function post_software_update_apply(req: BunRequest, runtime: Software_update_runtime = {}): Promise<Response> {
	const params = await params_of(req);
	const scan_id = params.get("scan") ?? "";
	const selected = params.getAll("selected");

	const snapshot = await load_snapshot(scan_id, runtime.snapshot_dir);
	if (!snapshot) return toast_redirect(req, "Reesync: scan expired. Rescan the source directory.", "red");
	if (selected.length === 0) return toast_redirect(req, "Reesync: no files selected.", "yellow", `${BASE_PATH}?scan=${scan_id}`);

	const acquired = await set_busy(GLOBAL_BUSY_KEY, { action: "software_update_apply", target: snapshot.source_root }, runtime.busy_file);
	if (!acquired) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow", `${BASE_PATH}?scan=${scan_id}`);

	try {
		const result = await apply_software_update(snapshot, selected);

		await record_run({
			action: "software_update_apply",
			target: snapshot.source_root,
			ok: result.failed.length === 0 && result.stale.length === 0,
			output: `copied=${result.copied.length} stale=${result.stale.length} failed=${result.failed.length}`,
			meta: { copied: result.copied, stale: result.stale, failed: result.failed },
		}, runtime.run_log_file);

		await delete_snapshot(snapshot.scan_id, runtime.snapshot_dir);

		const parts = [`copied ${result.copied.length}`];
		if (result.stale.length > 0) parts.push(`${result.stale.length} stale (skipped)`);
		if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
		const message = `Reesync: ${parts.join(", ")}.`;
		const type = result.failed.length > 0 || result.stale.length > 0 ? "yellow" : "green";
		return toast_redirect(req, message, type);
	} finally {
		await clear_busy(GLOBAL_BUSY_KEY, runtime.busy_file);
	}
}

// ---------------------------------------------------------------------------
// GET /software-update/diff - lazy, per-file diff/preview fragment
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escape_html(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]!);
}

function render_diff_fragment(entry: ScanEntry, source_bytes: Uint8Array | null, dest_bytes: Uint8Array | null): string {
	if (entry.state === "new") {
		if (!source_bytes) return `<p class="text-sm text-red-600">${escape_html("Source file no longer readable.")}</p>`;
		const result = build_preview(source_bytes);
		if (result.kind === "binary") return `<p class="text-sm text-text-secondary">Binary file - preview unavailable.</p>`;
		if (result.kind === "too-large") return `<p class="text-sm text-text-secondary">File too large for inline preview.</p>`;
		return `<pre class="text-xs overflow-x-auto bg-neutral-50 p-2 rounded">${result.lines.map((line) => escape_html(line)).join("\n")}</pre>`;
	}

	if (!source_bytes || !dest_bytes) return `<p class="text-sm text-red-600">${escape_html("File no longer readable on one side.")}</p>`;
	const result = build_diff(dest_bytes, source_bytes);
	if (result.kind === "binary") return `<p class="text-sm text-text-secondary">Binary file - byte size changed, no text preview.</p>`;
	if (result.kind === "too-large") return `<p class="text-sm text-text-secondary">File too large for inline diff.</p>`;

	const rows = result.hunks
		.map(
			(hunk) =>
			hunk.lines
				.map((line) => {
					const cls = line.kind === "add" ? "bg-green-50 text-green-800" : line.kind === "remove" ? "bg-red-50 text-red-800" : "";
					const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
					return `<div class="${cls} font-mono text-xs whitespace-pre px-1">${prefix} ${escape_html(line.text)}</div>`;
				})
				.join(""),
		)
		.join('<div class="text-text-secondary text-xs px-1">···</div>');

	return `<div class="border border-border rounded overflow-x-auto">${rows}</div>`;
}

export async function get_software_update_diff(req: BunRequest, runtime: Software_update_runtime = {}): Promise<Response> {
	const url = new URL(req.url);
	const scan_id = url.searchParams.get("scan") || "";
	const rel_path = url.searchParams.get("path") || "";

	const snapshot = await load_snapshot(scan_id, runtime.snapshot_dir);
	if (!snapshot) return new Response(`<p class="text-sm text-red-600">Scan expired - rescan to continue.</p>`, { status: 200, headers: { "Content-Type": "text/html" } });

	const entry = find_entry(snapshot, rel_path);
	if (!entry || entry.state === "project-only") {
		return new Response(`<p class="text-sm text-red-600">Unknown file for this scan.</p>`, { status: 200, headers: { "Content-Type": "text/html" } });
	}

	const source_abs = join_contained(snapshot.source_root, rel_path);
	const dest_abs = join_contained(snapshot.project_root, rel_path);
	if (!source_abs || !dest_abs) {
		return new Response(`<p class="text-sm text-red-600">Invalid path.</p>`, { status: 200, headers: { "Content-Type": "text/html" } });
	}

	const current_source_hash = await rehash(source_abs);
	const current_dest_hash = await rehash(dest_abs);
	if (current_source_hash !== entry.source_hash || current_dest_hash !== (entry.dest_hash ?? null)) {
		return new Response(`<p class="text-sm text-yellow-700">File changed since scan - rescan to see an up to date diff.</p>`, { status: 200, headers: { "Content-Type": "text/html" } });
	}

	const source_bytes = current_source_hash ? await Bun.file(source_abs).bytes() : null;
	const dest_bytes = current_dest_hash ? await Bun.file(dest_abs).bytes() : null;
	const html = render_diff_fragment(entry, source_bytes, dest_bytes);
	return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
}

function join_contained(root: string, rel_path: string): string | null {
	if (rel_path.includes("..") || rel_path.startsWith("/")) return null;
	const abs_path = `${root}/${rel_path}`;
	return is_contained(root, abs_path) ? abs_path : null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const software_update_crud = {
	"/software-update": { GET: get_software_update_page },
	"/software-update/scan": { POST: post_software_update_scan },
	"/software-update/ignore": { POST: post_software_update_ignore },
	"/software-update/ignore-selected": { POST: post_software_update_ignore_selected },
	"/software-update/apply": { POST: post_software_update_apply },
	"/software-update/diff": { GET: get_software_update_diff },
	"/software-update/browse": { GET: get_software_update_browse },
	"/software-update/commit-info": { GET: get_software_update_commit_info },
};

// ---------------------------------------------------------------------------
// GET /software-update/browse - list sibling directories for folder selector
// ---------------------------------------------------------------------------

function list_sibling_dirs(project_root: string): string[] {
	const parent = join(project_root, "..");
	try {
		const entries = readdirSync(parent, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
			.map((entry) => join(parent, entry.name))
			.filter((dir) => is_sibling(dir, project_root))
			.sort();
	} catch {
		return [];
	}
}

export async function get_software_update_browse(_req: BunRequest, _runtime: Software_update_runtime = {}): Promise<Response> {
	const dirs = list_sibling_dirs(PROJECT_ROOT);
	return Response.json({ dirs, project_root: PROJECT_ROOT });
}

// ---------------------------------------------------------------------------
// GET /software-update/commit-info - get git commit info from upstream source
// ---------------------------------------------------------------------------

function get_git_commit_info(source_root: string): { hash: string; message: string; author: string; date: string } | null {
	try {
		// Check if this is a git repository
		statSync(join(source_root, ".git"));
		// Get the latest commit info
		const result = execFileSync(
			"git",
			["-C", source_root, "log", "-1", "--format=%H|%s|%an|%ai"],
			{ encoding: "utf8", timeout: 5000 }
		);
		const [hash = "", message = "", author = "", date = ""] = result.trim().split("|");
		return { hash, message, author, date };
	} catch {
		return null;
	}
}

function get_git_head(source_root: string): string | null {
	try {
		statSync(join(source_root, ".git"));
		return execFileSync("git", ["-C", source_root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		return null;
	}
}

export async function get_software_update_commit_info(req: BunRequest, runtime: Software_update_runtime = {}): Promise<Response> {
	const url = new URL(req.url);
	const source = url.searchParams.get("source") || "";

	if (!source) {
		return Response.json({ error: "No source directory specified" }, { status: 400 });
	}

	const validation = await validate_source_dir(source, PROJECT_ROOT);
	if (!validation.ok) {
		return Response.json({ error: "Invalid source directory" }, { status: 400 });
	}

	const commit_info = get_git_commit_info(validation.canonical);
	return Response.json({ commit_info });
}

export const route_definitions: RouteDefinition[] = [
	{
		url: "/software-update",
		crud: software_update_crud,
		nav_title_key: "reeman.software_update",
		module: "system",
		nav_module: null,
	},
];
