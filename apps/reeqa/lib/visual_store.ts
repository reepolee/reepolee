import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { enqueue } from "$queue/index";

import { open_browser, type Qa_browser } from "./browser";
import { qa_runtime_dir, visual_capture_height, visual_capture_width } from "./config";
import { reset_and_snapshot, restore_snapshot } from "./db_snapshot";
import { announce_run_complete } from "./notify";
import { notify_evidence_ready, notify_recording_ready } from "./notify_ws";
import { find_page_set, is_workflow_page_set, page_set_capture_size, require_page_set, type Qa_page_set, type Workflow_page_set } from "./page_set_store";
import { read_project_env } from "./project_env";
import { find_project, type Qa_project } from "./project_store";
import { step_label, execute_workflow_step, type Workflow_step } from "./workflow";
import type { Changed_element } from "./dom_diff";
import { crop_image, image_difference, changed_elements_for_page, type Image_region } from "./visual_images";
import { record_page_clip, record_page_evidence_video } from "./visual_recording";
import { chrome_path, ffmpeg_path, ffprobe_path, say_path, settle_script, stabilize_script, vips_path, vipsheader_path, visual_capabilities } from "./visual_tools";

// Tool discovery and in-page scripts live in visual_tools.ts; they are
// re-exported here so existing importers of the run store keep working.
export { chrome_path, ffmpeg_path, ffprobe_path, say_path, settle_script, stabilize_script, visual_capabilities } from "./visual_tools";

export type Visual_operation = "baseline" | "compare";
export type Visual_run_status = "queued" | "running" | "canceling" | "passed" | "failed" | "canceled";
export type Visual_page_status = "baseline" | "changed" | "new" | "removed" | "unchanged";
export type Visual_evidence_status = "queued" | "running" | "failed";
export type Visual_recording_status = "queued" | "running" | "failed";

export type Visual_page = {
	id: string;
	url: string;
	status: Visual_page_status;
	baseline_path?: string;
	current_path?: string;
	diff_path?: string;
	baseline_zoom_path?: string;
	current_zoom_path?: string;
	diff_zoom_path?: string;
	/** The tight bounding box of what actually changed - "485x36px", not the padded zoom crop's own size. */
	diff_bounds_width?: number;
	diff_bounds_height?: number;
	video_path?: string;
	difference_pixels?: number;
	changed_elements?: Changed_element[];
	accepted_at?: string;
	/** Absent once video_path is set (done) or evidence was never requested. */
	evidence_status?: Visual_evidence_status;
	evidence_error?: string;
	/** Un-annotated clip for an unchanged (passing) page - mode 3 "recording run" in IN_PROGRESS_reeqa_qa_procedure.md §4. Absent once recording_path is set (done) or a recording was never requested. */
	recording_path?: string;
	recording_status?: Visual_recording_status;
	recording_error?: string;
	/** The filename this page's recording was last promoted to docs under (IN_PROGRESS_reeqa_qa_procedure.md §5b), if ever. */
	promoted_as?: string;
	/** Set only for a workflow checkpoint - its ordinal position among the page set's steps, so accept/sort can preserve execution order instead of sorting by URL. */
	step_index?: number;
};

export type Visual_run = {
	id: string;
	project_id: string;
	project_name: string;
	project_base_url: string;
	operation: Visual_operation;
	max_pages?: number;
	page_set_id?: string;
	page_set_name?: string;
	page_urls?: string[];
	capture_width?: number;
	capture_height?: number;
	status: Visual_run_status;
	started_at: string;
	finished_at?: string;
	duration_ms?: number;
	output: string;
	pages: Visual_page[];
};

type Baseline_page = {
	id: string;
	url: string;
	file: string;
	hash: string;
	dom?: string;
	html?: string;
	step_index?: number;
};

/** A non-checkpoint workflow step's own DOM snapshot - diagnostic only, not diffed by anything today (see IN_PROGRESS_reeqa_qa_procedure.md §3's divergence-localization decision, not yet built). */
type Baseline_step = { index: number; type: Workflow_step["type"]; dom: string };

type Baseline_manifest = {
	project_id: string;
	project_name: string;
	base_url: string;
	captured_at: string;
	capture_width?: number;
	capture_height?: number;
	sitemap_page_count?: number;
	capture_limit?: number;
	latest_capture_urls?: string[];
	db_snapshot?: string;
	pages: Baseline_page[];
	kind?: "urls" | "workflow";
	steps?: Baseline_step[];
	workflow_steps?: Workflow_step[];
};

export type Visual_baseline_summary = {
	base_url: string;
	captured_at: string;
	page_count: number;
	capture_width?: number;
	capture_height?: number;
	sitemap_page_count?: number;
	capture_limit?: number;
	urls: string[];
	latest_capture_urls: string[];
	retained_urls: string[];
	has_db_snapshot: boolean;
	db_snapshot_missing: boolean;
};

type Cancel_handle = { cancel(): void };

type Visual_runtime = {
	initialized: boolean;
	runs: Visual_run[];
	cancel_handles: Map<string, Cancel_handle>;
};

declare global {
	var __reeqa_visual_runtime: Visual_runtime | undefined;
}

const runtime_dir = qa_runtime_dir;
const baselines_root = join(runtime_dir, "baselines");
const reports_root = join(runtime_dir, "reports");
const visual_runs_path = join(runtime_dir, "visual-runs.json");
const output_limit = 2_000_000;
const windows_reserved_names = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
function get_runtime(): Visual_runtime {
	if (!globalThis.__reeqa_visual_runtime) {
		globalThis.__reeqa_visual_runtime = {
			initialized: false,
			runs: [],
			cancel_handles: new Map(),
		};
	}
	return globalThis.__reeqa_visual_runtime;
}

function is_visual_status(value: unknown): value is Visual_run_status {
	return value === "queued"
		|| value === "running"
		|| value === "canceling"
		|| value === "passed"
		|| value === "failed"
		|| value === "canceled";
}

function is_visual_operation(value: unknown): value is Visual_operation {
	return value === "baseline" || value === "compare";
}

function is_visual_run(value: unknown): value is Visual_run {
	if (!value || typeof value !== "object") return false;
	const run = value as Record<string, unknown>;
	return typeof run.id === "string"
		&& typeof run.project_id === "string"
		&& typeof run.project_name === "string"
		&& typeof run.project_base_url === "string"
		&& is_visual_operation(run.operation)
		&& (run.max_pages === undefined || typeof run.max_pages === "number")
		&& (run.page_set_id === undefined || typeof run.page_set_id === "string")
		&& (run.page_set_name === undefined || typeof run.page_set_name === "string")
		&& (run.page_urls === undefined || (Array.isArray(run.page_urls) && run.page_urls.every((url) => typeof url === "string")))
		&& (run.capture_width === undefined || (typeof run.capture_width === "number" && run.capture_width >= 1))
		&& (run.capture_height === undefined || (typeof run.capture_height === "number" && run.capture_height >= 1))
		&& is_visual_status(run.status)
		&& typeof run.started_at === "string"
		&& typeof run.output === "string"
		&& Array.isArray(run.pages);
}

async function initialize_runtime(): Promise<Visual_runtime> {
	const runtime = get_runtime();
	if (runtime.initialized) return runtime;
	let store_changed = false;
	const runs_file = Bun.file(visual_runs_path);
	const exists = await runs_file.exists();
	if (exists) {
		const saved_runs = await runs_file.json() as unknown;
		if (!Array.isArray(saved_runs) || !saved_runs.every(is_visual_run)) {
			throw new Error(`Invalid ReeQA visual run store: ${visual_runs_path}`);
		}
		runtime.runs = saved_runs;
		for (const run of runtime.runs) {
			const clean_output = Bun.stripANSI(run.output);
			if (clean_output === run.output) continue;
			run.output = clean_output;
			store_changed = true;
		}
	}
	// Visual runs are executed by the queue worker (or in-process as a fallback),
	// so a stale "running"/"queued" run here is NOT dead: the worker re-claims
	// the job and re-executes it (see execute_visual_run_job). Marking it failed
	// on boot would race the live worker, so nothing is changed here.

	runtime.initialized = true;
	if (store_changed) await persist_runs(runtime);
	return runtime;
}

/**
 * Re-read runs.json into this process's runtime. initialize_runtime() only
 * loads once per process, but the web server and the queue worker are
 * separate processes: whichever one is executing a run advances it on disk,
 * and every OTHER process's in-memory copy goes stale the instant that
 * happens. Read paths (list/find) call this so status changes made by the
 * worker show up without a restart. A run this process is itself driving
 * (tracked in cancel_handles) is kept from memory rather than overwritten by
 * disk, since disk may not yet reflect the in-flight mutation.
 */
async function refresh_runtime(): Promise<Visual_runtime> {
	const runtime = await initialize_runtime();
	const runs_file = Bun.file(visual_runs_path);
	if (!(await runs_file.exists())) return runtime;
	const saved_runs = await runs_file.json() as unknown;
	if (!Array.isArray(saved_runs) || !saved_runs.every(is_visual_run)) return runtime;
	runtime.runs = saved_runs.map((disk_run) => {
		if (!runtime.cancel_handles.has(disk_run.id)) return disk_run;
		return runtime.runs.find((run) => run.id === disk_run.id) ?? disk_run;
	});
	return runtime;
}

async function persist_runs(runtime: Visual_runtime): Promise<void> {
	mkdirSync(runtime_dir, { recursive: true });
	const body = `${JSON.stringify(runtime.runs, null, "\t")}\n`;
	// The web server and the queue worker are separate processes, each with
	// their own in-memory copy of runtime.runs, and both call this function.
	// A plain Bun.write() truncates in place, so two concurrent writers can
	// interleave and leave the file holding bytes from both - occasionally
	// still valid JSON, but failing the run-shape check on load. Write to a
	// sibling temp file and rename, which is atomic on the same filesystem.
	const tmp_path = `${visual_runs_path}.${process.pid}.${Date.now()}.tmp`;
	await Bun.write(tmp_path, body);
	renameSync(tmp_path, visual_runs_path);
}

function append_output(run: Visual_run, text: string): void {
	const clean_text = Bun.stripANSI(text);
	const combined = `${run.output}${clean_text}`;
	if (combined.length <= output_limit) {
		run.output = combined;
		return;
	}
	const start = combined.length - output_limit;
	run.output = `[Earlier output omitted]\n${combined.slice(start)}`;
}

function route_id(url: string): string {
	const parsed = new URL(url);
	const raw_path = parsed.pathname.replace(/^\/+|\/+$/g, "") || "home";
	let slug = raw_path.replace(/[^a-zA-Z0-9_-]+/g, "-");
	slug = slug.replace(/^-+|-+$/g, "").slice(0, 72) || "home";
	if (windows_reserved_names.test(slug)) slug = `route-${slug}`;
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`${parsed.pathname}${parsed.search}`);
	const digest = hasher.digest("hex").slice(0, 12);
	return `${slug}-${digest}`;
}

function normalize_site_url(raw_url: string, project: Qa_project): string {
	const parsed = new URL(raw_url);
	const base_url = new URL(project.base_url);
	parsed.protocol = base_url.protocol;
	parsed.host = base_url.host;
	parsed.hash = "";
	return parsed.href;
}

export type Sitemap_page = {
	url: string;
	lastmod?: string;
};

function sitemap_lastmod_rank(lastmod?: string): number {
	if (!lastmod) return -Infinity;
	const timestamp = Date.parse(lastmod);
	return Number.isNaN(timestamp) ? -Infinity : timestamp;
}

export async function sitemap_pages_for_project(project: Qa_project): Promise<Sitemap_page[]> {
	const sitemap_url = new URL("/sitemap.xml", project.base_url);
	const response = await fetch(sitemap_url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`Sitemap request failed with HTTP ${response.status}: ${sitemap_url.href}`);
	const xml = await response.text();
	const entries = [...xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/g)];
	const pages = entries.flatMap((match) => {
		const block = match[1]!;
		const loc = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/);
		if (!loc) return [];
		const lastmod = block.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/);
		return [{ url: normalize_site_url(loc[1]!, project), lastmod: lastmod?.[1] }];
	});
	const seen = new Map<string, Sitemap_page>();
	for (const page of pages) seen.set(page.url, page);
	const unique_pages = [...seen.values()];
	unique_pages.sort((a, b) => sitemap_lastmod_rank(b.lastmod) - sitemap_lastmod_rank(a.lastmod) || a.url.localeCompare(b.url));
	if (unique_pages.length === 0) throw new Error(`Sitemap contains no URLs: ${sitemap_url.href}`);
	return unique_pages;
}

async function start_visual_browser(run: Visual_run, profile_dir: string): Promise<Qa_browser> {
	const executable = chrome_path();
	const capture_width = run.capture_width ?? visual_capture_width;
	const capture_height = run.capture_height ?? visual_capture_height;
	const runtime = get_runtime();
	const browser = await open_browser({
		executable_path: executable,
		width: capture_width,
		height: capture_height,
		profile_dir,
	});
	try {
		runtime.cancel_handles.set(run.id, { cancel: () => browser.close() });
		await browser.install_on_new_document(stabilize_script());
		return browser;
	} catch (error) {
		browser.close();
		runtime.cancel_handles.delete(run.id);
		throw error;
	}
}

async function stop_visual_browser(run: Visual_run, browser: Qa_browser): Promise<void> {
	browser.close();
	const runtime = get_runtime();
	runtime.cancel_handles.delete(run.id);
}

/**
 * Everything after "the browser is already on the right page": settle, scroll
 * to a known offset, capture PNG/DOM-snapshot/HTML. Split out of capture_page
 * so a workflow checkpoint (reached through navigate/fill/click steps, not a
 * fresh navigate) can capture the same way without re-navigating.
 */
async function capture_current_view(run: Visual_run, browser: Qa_browser, label: string, screenshot_path: string, snapshot_path?: string, html_path?: string): Promise<void> {
	mkdirSync(dirname(screenshot_path), { recursive: true });
	await browser.evaluate(settle_script());
	// captureBeyondViewport extends the screenshot *below* the current scroll
	// position rather than always starting at the top of the page - a page
	// that scrolls itself on load (a hash anchor, a "restore scroll" script,
	// browser scroll-restoration on reload) shifts what capture_full_page()
	// returns, producing a false "changed" diff against a baseline captured
	// from a different scroll offset even when nothing on the page moved.
	await browser.evaluate("window.scrollTo(0, 0)");
	const screenshot = await browser.capture_full_page();
	await Bun.write(screenshot_path, screenshot);
	if (snapshot_path) {
		// DOM rects are in CSS pixels; the screenshot is in device pixels, so
		// store the page metrics alongside the snapshot to scale one to the
		// other when mapping a diff region back to its elements.
		const document = await browser.capture_dom_snapshot();
		const metrics = await browser.evaluate<{ dpr: number; width: number; height: number }>(
			"({ dpr: window.devicePixelRatio || 1, width: window.innerWidth, height: window.innerHeight })",
		);
		const snapshot = { document, inner_width: metrics.width, inner_height: metrics.height, device_pixel_ratio: metrics.dpr };
		await Bun.write(snapshot_path, JSON.stringify(snapshot));
	}
	if (html_path) {
		const html = await browser.capture_html();
		await Bun.write(html_path, html);
	}
	if (run.status === "canceling") throw new Error("Visual run canceled.");
	if (!existsSync(screenshot_path) || Bun.file(screenshot_path).size === 0) {
		throw new Error(`Chrome capture failed for ${label}.`);
	}
}

async function capture_page(run: Visual_run, browser: Qa_browser, url: string, screenshot_path: string, snapshot_path?: string, html_path?: string): Promise<void> {
	append_output(run, `Capture ${url}\n`);
	await browser.set_cookie({ name: "reepolee_cookie_consent", value: "accepted", url });
	try {
		await browser.navigate(url);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Chrome navigation failed for ${url}: ${reason}`);
	}
	await capture_current_view(run, browser, url, screenshot_path, snapshot_path, html_path);
}

/** DOM snapshot only, for a non-checkpoint workflow step - diagnostic, never a pass/fail input, so it skips settle_script()'s font-wait/animation-freeze and doesn't re-stamp DOM state a fill step just produced. */
async function capture_step_snapshot(browser: Qa_browser, snapshot_path: string): Promise<void> {
	mkdirSync(dirname(snapshot_path), { recursive: true });
	const document = await browser.capture_dom_snapshot();
	const metrics = await browser.evaluate<{ dpr: number; width: number; height: number }>(
		"({ dpr: window.devicePixelRatio || 1, width: window.innerWidth, height: window.innerHeight })",
	);
	const snapshot = { document, inner_width: metrics.width, inner_height: metrics.height, device_pixel_ratio: metrics.dpr };
	await Bun.write(snapshot_path, JSON.stringify(snapshot));
}

/** Checkpoint ids are ordinal, not URL-derived: two checkpoints on the same URL after different actions (before/after a submit) must not collide the way route_id() would. */
function checkpoint_id(step_index: number): string {
	return `step-${String(step_index + 1).padStart(3, "0")}`;
}

async function file_hash(file_path: string): Promise<string> {
	const file = Bun.file(file_path);
	const bytes = await file.arrayBuffer();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

export function relative_artifact(file_path: string): string {
	const resolved_path = resolve(file_path);
	const relative_path = relative(runtime_dir, resolved_path);
	if (!relative_path || relative_path.startsWith("..") || isAbsolute(relative_path)) {
		throw new Error(`Artifact is outside the ReeQA runtime directory: ${file_path}`);
	}
	return relative_path;
}

export function resolve_artifact(relative_path: string): string {
	const file_path = resolve(runtime_dir, relative_path);
	const contained_path = relative(runtime_dir, file_path);
	if (!contained_path || contained_path.startsWith("..") || isAbsolute(contained_path)) {
		throw new Error("Invalid ReeQA artifact path.");
	}
	return file_path;
}

function baseline_directory(project_id: string, page_set_id: string): string {
	return join(baselines_root, project_id, page_set_id);
}

const DB_SNAPSHOT_FILENAME = "db.snapshot";

async function load_baseline_manifest(project_id: string, page_set_id: string): Promise<Baseline_manifest | undefined> {
	const manifest_path = join(baseline_directory(project_id, page_set_id), "manifest.json");
	const file = Bun.file(manifest_path);
	const exists = await file.exists();
	if (!exists) return undefined;
	return await file.json() as Baseline_manifest;
}

async function write_baseline_manifest(directory: string, manifest: Baseline_manifest): Promise<void> {
	const body = `${JSON.stringify(manifest, null, "\t")}\n`;
	await Bun.write(join(directory, "manifest.json"), body);
}

async function capture_baseline_urls(run: Visual_run, browser: Qa_browser, urls: string[], staging_directory: string): Promise<{ pages: Baseline_page[] }> {
	const baseline_pages: Baseline_page[] = [];
	for (const url of urls) {
		const id = route_id(url);
		const screenshot_path = join(staging_directory, `${id}.png`);
		const snapshot_path = join(staging_directory, `${id}.dom.json`);
		const html_path = join(staging_directory, `${id}.html`);
		await capture_page(run, browser, url, screenshot_path, snapshot_path, html_path);
		const hash = await file_hash(screenshot_path);
		baseline_pages.push({ id, url, file: `${id}.png`, dom: `${id}.dom.json`, html: `${id}.html`, hash });
		run.pages.push({ id, url, status: "baseline", baseline_path: relative_artifact(screenshot_path) });
		await persist_runs(get_runtime());
	}
	return { pages: baseline_pages };
}

/**
 * Runs a workflow's steps once, in order, on one continuous browser session
 * (so a login step's cookies/session carry into later steps - the same
 * single-session-per-run architecture the URL-list path already has).
 * Every step gets a diagnostic DOM snapshot; only checkpoint steps get a
 * PNG+HTML and a Visual_page baseline entry (IN_PROGRESS_reeqa_qa_procedure.md
 * §2's "PNG at marked checkpoints; DOM snapshot at every step").
 */
async function capture_baseline_workflow(run: Visual_run, browser: Qa_browser, page_set: Workflow_page_set, project: Qa_project, staging_directory: string): Promise<{ pages: Baseline_page[]; steps: Baseline_step[]; workflow_steps: Workflow_step[] }> {
	const env = await read_project_env(project);
	const baseline_pages: Baseline_page[] = [];
	const baseline_steps: Baseline_step[] = [];
	await browser.set_cookie({ name: "reepolee_cookie_consent", value: "accepted", url: project.base_url });
	for (const [index, step] of page_set.steps.entries()) {
		append_output(run, `Step ${index + 1}: ${step_label(step)}\n`);
		await execute_workflow_step(browser, step, env);
		if (run.status === "canceling") throw new Error("Visual run canceled.");
		const id = checkpoint_id(index);
		if (!step.checkpoint) {
			const snapshot_path = join(staging_directory, `${id}.step.dom.json`);
			await capture_step_snapshot(browser, snapshot_path);
			baseline_steps.push({ index, type: step.type, dom: `${id}.step.dom.json` });
			continue;
		}
		const screenshot_path = join(staging_directory, `${id}.png`);
		const snapshot_path = join(staging_directory, `${id}.dom.json`);
		const html_path = join(staging_directory, `${id}.html`);
		await capture_current_view(run, browser, `checkpoint ${index + 1}`, screenshot_path, snapshot_path, html_path);
		const url = await browser.evaluate<string>("location.href");
		const hash = await file_hash(screenshot_path);
		baseline_pages.push({ id, url, step_index: index, file: `${id}.png`, dom: `${id}.dom.json`, html: `${id}.html`, hash });
		run.pages.push({ id, url, step_index: index, status: "baseline", baseline_path: relative_artifact(screenshot_path) });
		await persist_runs(get_runtime());
	}
	return { pages: baseline_pages, steps: baseline_steps, workflow_steps: page_set.steps };
}

async function generate_baseline(run: Visual_run, project: Qa_project): Promise<void> {
	if (!run.page_set_id) throw new Error("Select a page set before capturing a baseline.");
	const page_set = await require_page_set(project.id, run.page_set_id);
	const final_directory = baseline_directory(project.id, page_set.id);
	const staging_directory = `${final_directory}.staging-${run.id}`;
	const backup_directory = `${final_directory}.backup-${run.id}`;
	const profile_directory = join(runtime_dir, "profiles", run.id);
	if (existsSync(staging_directory)) rmSync(staging_directory, { recursive: true, force: true });
	if (existsSync(backup_directory)) rmSync(backup_directory, { recursive: true, force: true });
	let browser: Qa_browser | undefined;
	try {
		mkdirSync(staging_directory, { recursive: true });
		// Reset the test DB (clone dev -> test) and snapshot it alongside the
		// baseline images, so a later compare restores the identical starting
		// state. Projects without db:clone-test skip this and capture images only.
		// Resetting before the workflow's own steps run is in scope; only
		// resetting again before *compare* too is the deferred §2b problem.
		const took_db_snapshot = await reset_and_snapshot(project, join(staging_directory, DB_SNAPSHOT_FILENAME));
		browser = await start_visual_browser(run, profile_directory);

		const kind_fields: Pick<Baseline_manifest, "pages" | "kind" | "steps" | "workflow_steps"> = is_workflow_page_set(page_set)
			? { ...await capture_baseline_workflow(run, browser, page_set, project, staging_directory), kind: "workflow" }
			: await capture_baseline_urls(run, browser, page_set.urls, staging_directory);

		const manifest: Baseline_manifest = {
			project_id: project.id,
			project_name: project.name,
			base_url: project.base_url,
			captured_at: new Date().toISOString(),
			...(run.capture_width === undefined ? {} : { capture_width: run.capture_width }),
			...(run.capture_height === undefined ? {} : { capture_height: run.capture_height }),
			...(took_db_snapshot ? { db_snapshot: DB_SNAPSHOT_FILENAME } : {}),
			...kind_fields,
		};
		await write_baseline_manifest(staging_directory, manifest);
		try {
			if (existsSync(final_directory)) renameSync(final_directory, backup_directory);
			renameSync(staging_directory, final_directory);
			if (existsSync(backup_directory)) rmSync(backup_directory, { recursive: true, force: true });
		} catch (error) {
			if (!existsSync(final_directory) && existsSync(backup_directory)) renameSync(backup_directory, final_directory);
			throw error;
		}

		for (const page of run.pages) {
			page.baseline_path = relative_artifact(join(final_directory, `${page.id}.png`));
		}
		append_output(run, `Saved ${run.pages.length} baseline page(s) for page set ${page_set.name}.
`);
	} finally {
		if (browser) await stop_visual_browser(run, browser);
		if (existsSync(profile_directory)) rmSync(profile_directory, { recursive: true, force: true });
		if (existsSync(staging_directory)) rmSync(staging_directory, { recursive: true, force: true });
	}
}

async function restore_baseline_db(project: Qa_project, baseline: Baseline_manifest, baseline_dir: string): Promise<void> {
	if (!baseline.db_snapshot) return;
	const snapshot_path = join(baseline_dir, baseline.db_snapshot);
	if (!existsSync(snapshot_path)) {
		throw new Error("The baseline's database snapshot is missing. Recapture the baseline to restore it.");
	}
	const restored = await restore_snapshot(project, snapshot_path);
	if (!restored) throw new Error(`${project.name} no longer declares db:clone-test, so the baseline's database snapshot cannot be restored.`);
}

/**
 * Diffs one freshly-captured page/checkpoint against its stored baseline
 * entry and returns the Visual_page record - shared by both the URL-list and
 * workflow compare loops so the hash-compare/crop/changed-elements math is
 * written once. Does not push into run.pages or persist; the caller does
 * that immediately after, matching the existing per-page progress pattern.
 */
async function diff_captured_page(baseline_dir: string, report_directory: string, baseline_page: Baseline_page | undefined, id: string, url: string, current_path: string, current_snapshot_path: string, current_html_path: string): Promise<Visual_page> {
	const current_hash = await file_hash(current_path);
	const step_index_field = baseline_page?.step_index === undefined ? {} : { step_index: baseline_page.step_index };
	if (!baseline_page) {
		return { id, url, status: "new", current_path: relative_artifact(current_path), ...step_index_field };
	}
	const stored_baseline_path = join(baseline_dir, baseline_page.file);
	if (baseline_page.hash === current_hash) {
		return {
			id,
			url,
			status: "unchanged",
			baseline_path: relative_artifact(current_path),
			current_path: relative_artifact(current_path),
			...step_index_field,
		};
	}
	const report_baseline_path = join(report_directory, `${id}-baseline.png`);
	cpSync(stored_baseline_path, report_baseline_path);
	const diff_path = join(report_directory, `${id}-diff.png`);
	const { difference_pixels, region, bounds } = image_difference(report_baseline_path, current_path, diff_path);
	const baseline_zoom_path = join(report_directory, `${id}-baseline-zoom.png`);
	const current_zoom_path = join(report_directory, `${id}-current-zoom.png`);
	const diff_zoom_path = join(report_directory, `${id}-diff-zoom.png`);
	crop_image(report_baseline_path, baseline_zoom_path, region);
	crop_image(current_path, current_zoom_path, region);
	crop_image(diff_path, diff_zoom_path, region);
	const baseline_snapshot_path = join(baseline_dir, baseline_page.dom ?? `${id}.dom.json`);
	const baseline_html_path = baseline_page.html ? join(baseline_dir, baseline_page.html) : undefined;
	const changed_elements = await changed_elements_for_page(baseline_snapshot_path, current_snapshot_path, current_path, bounds, baseline_html_path, current_html_path);
	return {
		id,
		url,
		status: "changed",
		baseline_path: relative_artifact(report_baseline_path),
		current_path: relative_artifact(current_path),
		diff_path: relative_artifact(diff_path),
		baseline_zoom_path: relative_artifact(baseline_zoom_path),
		current_zoom_path: relative_artifact(current_zoom_path),
		diff_zoom_path: relative_artifact(diff_zoom_path),
		difference_pixels,
		diff_bounds_width: bounds.width,
		diff_bounds_height: bounds.height,
		changed_elements,
		...step_index_field,
	};
}

async function compare_urls_current(run: Visual_run, project: Qa_project, baseline: Baseline_manifest, browser: Qa_browser, report_directory: string): Promise<void> {
	const baseline_dir = baseline_directory(project.id, run.page_set_id!);
	const current_urls = baseline.pages.map((page) => page.url);
	const baseline_by_url = new Map(baseline.pages.map((page) => [page.url, page]));
	for (const url of current_urls) {
		const id = route_id(url);
		const current_path = join(report_directory, `${id}-current.png`);
		const current_snapshot_path = join(report_directory, `${id}-current.dom.json`);
		const current_html_path = join(report_directory, `${id}-current.html`);
		await capture_page(run, browser, url, current_path, current_snapshot_path, current_html_path);
		const baseline_page = baseline_by_url.get(url);
		if (baseline_page) baseline_by_url.delete(url);
		run.pages.push(await diff_captured_page(baseline_dir, report_directory, baseline_page, id, url, current_path, current_snapshot_path, current_html_path));
		await persist_runs(get_runtime());
	}
}

/**
 * Replays the page set's *current* steps (not the baseline's snapshot) and
 * diffs only at checkpoints. Timing fields (delay_seconds, before_seconds,
 * outline_seconds, glide_seconds) stay editable on the page set and take
 * effect here without recapturing the baseline - the baseline only supplies
 * the checkpoint screenshots being diffed against. Non-checkpoint steps'
 * snapshots are captured on the compare side too
 * (${id}-current.step.dom.json) but not diffed by anything yet - that's the
 * divergence-localization UI, not built in this phase.
 */
async function compare_workflow_current(run: Visual_run, project: Qa_project, baseline: Baseline_manifest, page_set: Workflow_page_set, browser: Qa_browser, report_directory: string): Promise<void> {
	const baseline_dir = baseline_directory(project.id, run.page_set_id!);
	const env = await read_project_env(project);
	const steps = page_set.steps;
	const baseline_by_id = new Map(baseline.pages.map((page) => [page.id, page]));
	await browser.set_cookie({ name: "reepolee_cookie_consent", value: "accepted", url: project.base_url });
	for (const [index, step] of steps.entries()) {
		append_output(run, `Step ${index + 1}: ${step_label(step)}\n`);
		await execute_workflow_step(browser, step, env);
		if (run.status === "canceling") throw new Error("Visual run canceled.");
		const id = checkpoint_id(index);
		if (!step.checkpoint) {
			await capture_step_snapshot(browser, join(report_directory, `${id}-current.step.dom.json`));
			continue;
		}
		const current_path = join(report_directory, `${id}-current.png`);
		const current_snapshot_path = join(report_directory, `${id}-current.dom.json`);
		const current_html_path = join(report_directory, `${id}-current.html`);
		await capture_current_view(run, browser, `checkpoint ${index + 1}`, current_path, current_snapshot_path, current_html_path);
		const url = await browser.evaluate<string>("location.href");
		run.pages.push(await diff_captured_page(baseline_dir, report_directory, baseline_by_id.get(id), id, url, current_path, current_snapshot_path, current_html_path));
		await persist_runs(get_runtime());
	}
}

async function compare_current(run: Visual_run, project: Qa_project): Promise<void> {
	if (!run.page_set_id) throw new Error("Select a page set before comparing.");
	const page_set = await require_page_set(project.id, run.page_set_id);
	const baseline = await load_baseline_manifest(project.id, run.page_set_id);
	if (!baseline) throw new Error(`No visual baseline exists for page set ${run.page_set_name ?? run.page_set_id}. Capture the baseline first.`);
	if ((baseline.kind === "workflow") !== is_workflow_page_set(page_set)) {
		throw new Error("The stored baseline was captured for a different page set type. Capture the baseline again.");
	}
	await restore_baseline_db(project, baseline, baseline_directory(project.id, run.page_set_id));
	const report_directory = join(reports_root, run.id);
	const profile_directory = join(runtime_dir, "profiles", run.id);
	mkdirSync(report_directory, { recursive: true });
	let browser: Qa_browser | undefined;
	try {
		browser = await start_visual_browser(run, profile_directory);
		if (is_workflow_page_set(page_set)) await compare_workflow_current(run, project, baseline, page_set, browser, report_directory);
		else await compare_urls_current(run, project, baseline, browser, report_directory);

		append_output(run, `Compared ${run.pages.length} page(s).\n`);
	} finally {
		if (browser) await stop_visual_browser(run, browser);
		if (existsSync(profile_directory)) rmSync(profile_directory, { recursive: true, force: true });
	}

	// Evidence recording is a separate, explicit action per page (mode 2 -
	// "evidence run" in IN_PROGRESS_reeqa_qa_procedure.md §4) - see
	// start_page_evidence_run() below. It never runs automatically here: it's
	// slow (Chrome + TTS + ffmpeg per page) and most changed pages are
	// reviewed from the diff image alone.
}

/** Queue (or run in-process as a fallback) a narrated evidence recording for one changed/new page. */
export async function start_page_evidence_run(run_id: string, page_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run || run.operation !== "compare") throw new Error("Visual comparison report not found.");
	if (run.status !== "passed" && run.status !== "failed") throw new Error("The visual comparison is not complete.");
	const page = run.pages.find((item) => item.id === page_id);
	if (!page) throw new Error("Visual report page not found.");
	if (page.status !== "changed" && page.status !== "new") throw new Error("Evidence recording only applies to changed or new pages.");
	if (page.evidence_status === "queued" || page.evidence_status === "running") throw new Error("Evidence recording is already in progress for this page.");

	page.evidence_status = "queued";
	page.evidence_error = undefined;
	await persist_runs(runtime);

	try {
		await enqueue({ type: "reeqa_evidence", payload: { run_id, page_id } });
	} catch (error) {
		console.warn(`[reeqa] Queue unavailable - recording evidence for ${run_id}/${page_id} in-process: ${error instanceof Error ? error.message : String(error)}`);
		void execute_page_evidence_job(run_id, page_id);
	}
}

/** Executed by the queue worker (registered as `reeqa_evidence` in workers.ts), or in-process as a fallback. */
export async function execute_page_evidence_job(run_id: string, page_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) throw new Error(`Unknown visual run: ${run_id}`);
	const page = run.pages.find((item) => item.id === page_id);
	if (!page) throw new Error(`Unknown visual report page: ${page_id}`);

	page.evidence_status = "running";
	await persist_runs(runtime);

	let video_path: string | undefined;
	let error_message: string | undefined;
	try {
		const project = await find_project(run.project_id);
		if (!project) throw new Error("QA project not found.");
		video_path = relative_artifact(await record_page_evidence_video(run, page, project));
		page.video_path = video_path;
		page.evidence_status = undefined;
		page.evidence_error = undefined;
	} catch (error) {
		page.evidence_status = "failed";
		error_message = error instanceof Error ? error.message : String(error);
		page.evidence_error = error_message;
	}
	await persist_runs(runtime);
	notify_evidence_ready(run_id, page.id, video_path, error_message);
}

/** Queue (or run in-process as a fallback) a clean recording clip for one unchanged page. */
export async function start_page_recording_run(run_id: string, page_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run || run.operation !== "compare") throw new Error("Visual comparison report not found.");
	if (run.status !== "passed" && run.status !== "failed") throw new Error("The visual comparison is not complete.");
	const page = run.pages.find((item) => item.id === page_id);
	if (!page) throw new Error("Visual report page not found.");
	if (page.status !== "unchanged") throw new Error("Recording only applies to unchanged pages.");
	if (page.recording_status === "queued" || page.recording_status === "running") throw new Error("Recording is already in progress for this page.");

	page.recording_status = "queued";
	page.recording_error = undefined;
	await persist_runs(runtime);

	try {
		await enqueue({ type: "reeqa_recording", payload: { run_id, page_id } });
	} catch (error) {
		console.warn(`[reeqa] Queue unavailable - recording clip for ${run_id}/${page_id} in-process: ${error instanceof Error ? error.message : String(error)}`);
		void execute_page_recording_job(run_id, page_id);
	}
}

/** Executed by the queue worker (registered as `reeqa_recording` in workers.ts), or in-process as a fallback. */
export async function execute_page_recording_job(run_id: string, page_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) throw new Error(`Unknown visual run: ${run_id}`);
	const page = run.pages.find((item) => item.id === page_id);
	if (!page) throw new Error(`Unknown visual report page: ${page_id}`);

	page.recording_status = "running";
	await persist_runs(runtime);

	let recording_path: string | undefined;
	let error_message: string | undefined;
	try {
		const project = await find_project(run.project_id);
		if (!project) throw new Error("QA project not found.");
		recording_path = relative_artifact(await record_page_clip(run, page, project));
		page.recording_path = recording_path;
		page.recording_status = undefined;
		page.recording_error = undefined;
	} catch (error) {
		page.recording_status = "failed";
		error_message = error instanceof Error ? error.message : String(error);
		page.recording_error = error_message;
	}
	await persist_runs(runtime);
	notify_recording_ready(run_id, page.id, recording_path, error_message);
}

function is_canceling(run: Visual_run): boolean {
	return run.status === "canceling";
}

function announce_visual_completion(run: Visual_run): void {
	if (run.status === "canceled" || run.operation !== "compare") return;
	const changed_count = run.pages.filter((page) => page.status === "changed" || page.status === "new" || page.status === "removed").length;
	const total = run.pages.length;
	if (run.status === "failed") {
		void announce_run_complete(`Visual comparison failed on ${run.project_name}.`, false);
		return;
	}
	if (changed_count > 0) {
		void announce_run_complete(`Some tests failed: ${changed_count} of ${total} pages changed in ${run.project_name}.`, false);
	} else {
		void announce_run_complete(`All tests passed: ${total} pages unchanged in ${run.project_name}.`, true);
	}
}

async function execute_visual_run(run: Visual_run, project: Qa_project): Promise<void> {
	const runtime = get_runtime();
	run.status = "running";
	await persist_runs(runtime);
	try {
		if (run.operation === "baseline") await generate_baseline(run, project);
		else await compare_current(run, project);
		if (is_canceling(run)) run.status = "canceled";
		else run.status = "passed";
	} catch (error) {
		if (is_canceling(run)) run.status = "canceled";
		else run.status = "failed";
		append_output(run, `${error instanceof Error ? error.message : String(error)}\n`);
	}
	run.finished_at = new Date().toISOString();
	run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
	runtime.cancel_handles.delete(run.id);
	await persist_runs(runtime);
	announce_visual_completion(run);
	await trigger_auto_evidence(run);
	await trigger_auto_recording(run);
}

/**
 * A page set can opt into automatic evidence recording (its `auto_evidence`
 * flag) so a compare run's changed/new pages get a narrated video without a
 * manual "Record evidence" click per page. Runs after the run's own
 * "passed"/"failed" status is already persisted - start_page_evidence_run()
 * re-reads the run from disk and rejects anything still "running".
 */
async function trigger_auto_evidence(run: Visual_run): Promise<void> {
	if (run.operation !== "compare" || !run.page_set_id) return;
	if (run.status !== "passed" && run.status !== "failed") return;
	const page_set = await find_page_set(run.page_set_id);
	if (!page_set?.auto_evidence) return;
	const eligible_pages = run.pages.filter((page) => (page.status === "changed" || page.status === "new") && !page.video_path && !page.evidence_status);
	for (const page of eligible_pages) {
		try {
			await start_page_evidence_run(run.id, page.id);
		} catch (error) {
			console.warn(`[reeqa] Auto evidence failed to start for ${run.id}/${page.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/**
 * A page set can opt into automatic recording (its `auto_recording` flag) so
 * a compare run's unchanged (passing) pages get a clean, un-annotated video
 * without a manual click - the only way a video exists for a dynamic test
 * that passed (IN_PROGRESS_reeqa_qa_procedure.md §4).
 */
async function trigger_auto_recording(run: Visual_run): Promise<void> {
	if (run.operation !== "compare" || !run.page_set_id) return;
	if (run.status !== "passed" && run.status !== "failed") return;
	const page_set = await find_page_set(run.page_set_id);
	if (!page_set?.auto_recording) return;
	const eligible_pages = run.pages.filter((page) => page.status === "unchanged" && !page.recording_path && !page.recording_status);
	for (const page of eligible_pages) {
		try {
			await start_page_recording_run(run.id, page.id);
		} catch (error) {
			console.warn(`[reeqa] Auto recording failed to start for ${run.id}/${page.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export async function list_visual_runs(): Promise<Visual_run[]> {
	const runtime = await refresh_runtime();
	return [...runtime.runs];
}

export async function find_visual_run(run_id: string): Promise<Visual_run | undefined> {
	const runtime = await refresh_runtime();
	return runtime.runs.find((run) => run.id === run_id);
}

export async function find_active_visual_run(): Promise<Visual_run | undefined> {
	const runtime = await refresh_runtime();
	return runtime.runs.find((run) => run.status === "queued" || run.status === "running" || run.status === "canceling");
}

export async function start_visual_run(
	project_id: string,
	operation: Visual_operation,
	page_set_id: string,
): Promise<Visual_run> {
	const runtime = await refresh_runtime();
	const active_run = await find_active_visual_run();
	if (active_run) throw new Error(`${active_run.project_name} already has a visual run in progress.`);
	const project = await find_project(project_id);
	if (!project) throw new Error("QA project not found.");
	chrome_path();
	if (operation === "compare") {
		vips_path();
		vipsheader_path();
	}
	const page_set = await require_page_set(project.id, page_set_id);
	const { width: capture_width, height: capture_height } = page_set_capture_size(page_set);

	const run: Visual_run = {
		id: crypto.randomUUID(),
		project_id: project.id,
		project_name: project.name,
		project_base_url: project.base_url,
		operation,
		page_set_id: page_set.id,
		page_set_name: page_set.name,
		page_urls: is_workflow_page_set(page_set)
			? page_set.steps.flatMap((step) => step.type === "navigate" ? [step.url] : [])
			: [...page_set.urls],
		capture_width,
		capture_height,
		status: "queued",
		started_at: new Date().toISOString(),
		output: "",
		pages: [],
	};
	runtime.runs.unshift(run);
	await persist_runs(runtime);

	// Execute through the queue worker when available, falling back to
	// in-process execution (the pre-queue behavior) when it is not.
	try {
		await enqueue({ type: "reeqa_visual_run", payload: { run_id: run.id } });
	} catch (error) {
		console.warn(`[reeqa] Queue unavailable - executing visual run ${run.id} in-process: ${error instanceof Error ? error.message : String(error)}`);
		void execute_visual_run_job(run.id);
	}
	return run;
}

/**
 * Execute a visual run (Chrome capture + vips diff) by id. Runs in the queue
 * worker (registered as `reeqa_visual_run` in workers.ts) - or in-process as
 * a fallback when the queue is unavailable. Re-executes a stale
 * "running"/"queued" run (e.g. a job re-claimed after a worker crash);
 * completed runs are left untouched.
 */
export async function execute_visual_run_job(run_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) throw new Error(`Unknown visual run: ${run_id}`);
	if (run.status === "passed" || run.status === "failed" || run.status === "canceled") return;
	if (run.status === "canceling") {
		run.status = "canceled";
		run.finished_at = new Date().toISOString();
		run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
		await persist_runs(runtime);
		return;
	}

	// Fresh attempt (covers re-execution after a worker crash).
	run.status = "running";
	run.output = "";
	run.started_at = new Date().toISOString();
	delete run.finished_at;
	delete run.duration_ms;
	await persist_runs(runtime);

	const project = await find_project(run.project_id);
	if (!project) throw new Error("QA project not found.");
	await execute_visual_run(run, project);
}

export async function cancel_visual_run(run_id: string): Promise<Visual_run> {
	const run = await find_visual_run(run_id);
	if (!run) throw new Error("Visual run not found.");
	if (run.status === "passed" || run.status === "failed" || run.status === "canceled") {
		throw new Error("Only a running visual job can be canceled.");
	}
	const runtime = get_runtime();

	// A "queued" run has no browser session yet - either it never got picked
	// up (nothing to close) or a job for it is still coming, which would try
	// to start capturing after a user just asked to cancel. Finalize directly
	// rather than parking it in "canceling" waiting for a job that finalizes
	// it, which never arrives if the run's job already ran and terminated.
	if (run.status === "queued") {
		run.status = "canceled";
		run.finished_at = new Date().toISOString();
		run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
		await persist_runs(runtime);
		return run;
	}

	if (run.status !== "canceling") {
		run.status = "canceling";
		await persist_runs(runtime);
	}

	// The browser session lives in the queue worker - ask it to close it. Falls
	// back to a direct close when the queue is unavailable (in-process execution).
	try {
		await enqueue({ type: "reeqa_cancel", payload: { run_id, kind: "visual" } });
	} catch (error) {
		runtime.cancel_handles.get(run.id)?.cancel();
	}
	return run;
}

/**
 * Cancel a visual run's browser session from the queue worker (the
 * reeqa_cancel handler). The server sets the status to "canceling" before
 * enqueueing; this mirrors that on the worker's own in-memory record and
 * closes the browser, so execute_visual_run finalizes the run as "canceled".
 */
export async function cancel_visual_run_in_worker(run_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) return;
	if (run.status === "passed" || run.status === "failed" || run.status === "canceled") return;
	if (run.status !== "canceling") {
		run.status = "canceling";
		await persist_runs(runtime);
	}
	runtime.cancel_handles.get(run_id)?.cancel();
}

export async function delete_visual_report(run_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run_index = runtime.runs.findIndex((run) => run.id === run_id);
	if (run_index < 0) throw new Error("Comparison report not found.");
	const run = runtime.runs[run_index]!;
	if (run.operation !== "compare") throw new Error("Only comparison reports can be removed.");
	if (run.status === "queued" || run.status === "running" || run.status === "canceling") {
		throw new Error("An active comparison report cannot be removed.");
	}
	const report_directory = join(reports_root, run.id);
	if (existsSync(report_directory)) rmSync(report_directory, { recursive: true, force: true });
	runtime.runs.splice(run_index, 1);
	await persist_runs(runtime);
}

export async function clear_visual_reports(project_id?: string, page_set_id?: string): Promise<number> {
	const runtime = await refresh_runtime();
	const removable_runs = runtime.runs.filter((run) => run.operation === "compare"
		&& run.status !== "queued"
		&& run.status !== "running"
		&& run.status !== "canceling"
		&& (project_id === undefined || run.project_id === project_id)
		&& (page_set_id === undefined || run.page_set_id === page_set_id));
	const removable_ids = new Set(removable_runs.map((run) => run.id));
	for (const run of removable_runs) {
		const report_directory = join(reports_root, run.id);
		if (existsSync(report_directory)) rmSync(report_directory, { recursive: true, force: true });
	}
	runtime.runs = runtime.runs.filter((run) => !removable_ids.has(run.id));
	await persist_runs(runtime);
	return removable_runs.length;
}

export async function has_baseline(project_id: string, page_set_id: string): Promise<boolean> {
	return Boolean(await load_baseline_manifest(project_id, page_set_id));
}

export async function get_baseline_summary(project_id: string, page_set_id: string): Promise<Visual_baseline_summary | undefined> {
	const manifest = await load_baseline_manifest(project_id, page_set_id);
	if (!manifest) return undefined;
	const urls = manifest.pages.map((page) => page.url);
	const migrated_latest_urls = manifest.capture_limit === undefined
		? urls
		: urls.slice(0, manifest.capture_limit);
	const latest_capture_urls = manifest.latest_capture_urls ?? migrated_latest_urls;
	const latest_capture_set = new Set(latest_capture_urls);
	const retained_urls = urls.filter((url) => !latest_capture_set.has(url));
	const db_snapshot_path = manifest.db_snapshot === undefined ? undefined : join(baseline_directory(project_id, page_set_id), manifest.db_snapshot);
	const has_db_snapshot = db_snapshot_path !== undefined && existsSync(db_snapshot_path);
	const db_snapshot_missing = db_snapshot_path !== undefined && !has_db_snapshot;
	return {
		base_url: manifest.base_url,
		captured_at: manifest.captured_at,
		page_count: manifest.pages.length,
		...(manifest.capture_width === undefined ? {} : { capture_width: manifest.capture_width }),
		...(manifest.capture_height === undefined ? {} : { capture_height: manifest.capture_height }),
		...(manifest.sitemap_page_count === undefined ? {} : { sitemap_page_count: manifest.sitemap_page_count }),
		...(manifest.capture_limit === undefined ? {} : { capture_limit: manifest.capture_limit }),
		urls,
		latest_capture_urls,
		retained_urls,
		has_db_snapshot,
		db_snapshot_missing,
	};
}

export async function accept_visual_page(run_id: string, page_id: string): Promise<void> {
	const run = await find_visual_run(run_id);
	if (!run || run.operation !== "compare") throw new Error("Visual comparison report not found.");
	if (run.status !== "passed" && run.status !== "failed") throw new Error("The visual comparison is not complete.");
	const page = run.pages.find((item) => item.id === page_id);
	if (!page) throw new Error("Visual report page not found.");
	if (page.status === "unchanged") return;
	if (!run.page_set_id) throw new Error("Visual baseline page set is missing.");
	const manifest = await load_baseline_manifest(run.project_id, run.page_set_id);
	if (!manifest) throw new Error("Visual baseline manifest not found.");
	const baseline_dir = baseline_directory(run.project_id, run.page_set_id);
	const page_index = manifest.pages.findIndex((item) => item.id === page.id);

	if (page.status === "removed") {
		if (page_index >= 0) {
			const baseline_page = manifest.pages[page_index]!;
			const baseline_path = join(baseline_dir, baseline_page.file);
			if (existsSync(baseline_path)) rmSync(baseline_path);
			manifest.pages.splice(page_index, 1);
		}
	} else {
		if (!page.current_path) throw new Error("Current screenshot is missing.");
		const current_path = resolve_artifact(page.current_path);
		const baseline_path = join(baseline_dir, `${page.id}.png`);
		await Bun.write(baseline_path, Bun.file(current_path));
		const hash = await file_hash(baseline_path);
		// Promote the DOM snapshot and HTML captured with the accepted
		// screenshot too, so a later comparison has structural/HTML
		// references for this page.
		const current_snapshot_path = join(reports_root, run.id, `${page.id}-current.dom.json`);
		let dom: string | undefined;
		if (existsSync(current_snapshot_path)) {
			await Bun.write(join(baseline_dir, `${page.id}.dom.json`), Bun.file(current_snapshot_path));
			dom = `${page.id}.dom.json`;
		}
		const current_html_path = join(reports_root, run.id, `${page.id}-current.html`);
		let html: string | undefined;
		if (existsSync(current_html_path)) {
			await Bun.write(join(baseline_dir, `${page.id}.html`), Bun.file(current_html_path));
			html = `${page.id}.html`;
		}
		const baseline_page: Baseline_page = { id: page.id, url: page.url, file: `${page.id}.png`, hash, ...(dom ? { dom } : {}), ...(html ? { html } : {}), ...(page.step_index === undefined ? {} : { step_index: page.step_index }) };
		if (page_index >= 0) manifest.pages[page_index] = baseline_page;
		else manifest.pages.push(baseline_page);
		// A workflow's execution order matters - sorting by URL would scramble
		// it (two checkpoints can share a URL after different actions).
		if (manifest.kind === "workflow") manifest.pages.sort((left, right) => (left.step_index ?? 0) - (right.step_index ?? 0));
		else manifest.pages.sort((left, right) => left.url.localeCompare(right.url));
		page.baseline_path = page.current_path;
	}

	manifest.captured_at = new Date().toISOString();
	await write_baseline_manifest(baseline_dir, manifest);
	page.accepted_at = new Date().toISOString();
	await persist_runs(get_runtime());
}

function sanitized_docs_filename(name_value: string): string {
	const trimmed = name_value.trim();
	if (!trimmed) throw new Error("A filename is required.");
	const base = trimmed.replace(/\.mp4$/i, "");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(base)) {
		throw new Error("Filename may only contain letters, numbers, dots, dashes and underscores.");
	}
	return `${base}.mp4`;
}

/**
 * Copy a passed page's mode-3 recording into the selected project's docs video
 * folder under a stable name (IN_PROGRESS_reeqa_qa_procedure.md §5b) - never
 * automatic, always an explicit click on an already-recorded, already-passed
 * clip.
 */
export async function promote_page_recording(run_id: string, page_id: string, filename: string): Promise<string> {
	const run = await find_visual_run(run_id);
	if (!run || run.operation !== "compare") throw new Error("Visual comparison report not found.");
	const page = run.pages.find((item) => item.id === page_id);
	if (!page) throw new Error("Visual report page not found.");
	if (page.status !== "unchanged" || !page.recording_path) throw new Error("Only a passed page's recording can be promoted to docs.");
	const project = await find_project(run.project_id);
	if (!project) throw new Error("QA project not found.");

	const safe_name = sanitized_docs_filename(filename);
	const docs_videos_dir = join(project.path, "src", "public", "videos");
	mkdirSync(docs_videos_dir, { recursive: true });
	const destination_path = join(docs_videos_dir, safe_name);
	await Bun.write(destination_path, Bun.file(resolve_artifact(page.recording_path)));

	page.promoted_as = safe_name;
	await persist_runs(get_runtime());
	return safe_name;
}

export function visual_asset_file(relative_path: string): Bun.BunFile {
	return Bun.file(resolve_artifact(relative_path));
}
