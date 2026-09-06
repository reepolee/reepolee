import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { qa_config_dir, visual_capture_height, visual_capture_width } from "./config";
import { find_project, type Qa_project } from "./project_store";
import { is_workflow_step, type Workflow_step } from "./workflow";

type Page_set_base = {
	id: string;
	project_id: string;
	name: string;
	created_at: string;
	updated_at: string;
	// Browser viewport used for baseline capture and comparison. Optional for
	// legacy sets; consumers fall back to the desktop default (1920x1080).
	capture_width?: number;
	capture_height?: number;
	// When true, a compare run against this page set automatically records
	// narrated evidence for every changed/new page instead of requiring a
	// manual "Record evidence" click per page (see visual_store.ts's
	// trigger_auto_evidence, called once a compare run finishes).
	auto_evidence?: boolean;
	// When true, also record a clean (un-annotated) video for pages that
	// *didn't* change - "recording run" / mode 3 in
	// IN_PROGRESS_reeqa_qa_procedure.md §4, the only way a video exists for a
	// dynamic test that passed.
	auto_recording?: boolean;
};

// `kind` is absent on every page set saved before workflow sets existed -
// absent means "urls", so page-sets.json needs no migration.
export type Url_page_set = Page_set_base & { kind?: "urls"; urls: string[] };
export type Workflow_page_set = Page_set_base & { kind: "workflow"; steps: Workflow_step[] };
export type Qa_page_set = Url_page_set | Workflow_page_set;

export function is_workflow_page_set(page_set: Qa_page_set): page_set is Workflow_page_set {
	return page_set.kind === "workflow";
}

/** Pages for a URL-list set, checkpoints for a workflow set - the number of things a run actually compares. */
export function page_set_page_count(page_set: Qa_page_set): number {
	return is_workflow_page_set(page_set) ? page_set.steps.filter((step) => step.checkpoint).length : page_set.urls.length;
}

export function page_set_capture_size(page_set: Qa_page_set): { width: number; height: number; } {
	return {
		width: page_set.capture_width ?? visual_capture_width,
		height: page_set.capture_height ?? visual_capture_height,
	};
}

const page_sets_path = join(qa_config_dir, "page-sets.json");
const active_page_set_path = join(qa_config_dir, "active-page-set.json");

type Active_page_set_record = { project_id: string; page_set_id: string; };

function is_active_page_set_store(value: unknown): value is Active_page_set_record {
	if (!value || typeof value !== "object") return false;
	const store = value as Record<string, unknown>;
	return typeof store.project_id === "string" && store.project_id.length > 0
		&& typeof store.page_set_id === "string" && store.page_set_id.length > 0;
}

async function read_active_page_set(): Promise<Active_page_set_record | undefined> {
	const file = Bun.file(active_page_set_path);
	const exists = await file.exists();
	if (!exists) return undefined;
	const value = await file.json() as unknown;
	if (!is_active_page_set_store(value)) return undefined;
	return value;
}

async function clear_active_page_set(): Promise<void> {
	if (existsSync(active_page_set_path)) rmSync(active_page_set_path);
}

function is_page_set(value: unknown): value is Qa_page_set {
	if (!value || typeof value !== "object") return false;
	const page_set = value as Record<string, unknown>;
	const shared_checks = typeof page_set.id === "string"
		&& typeof page_set.project_id === "string"
		&& typeof page_set.name === "string"
		&& (page_set.capture_width === undefined || (typeof page_set.capture_width === "number" && page_set.capture_width >= 1))
		&& (page_set.capture_height === undefined || (typeof page_set.capture_height === "number" && page_set.capture_height >= 1))
		&& (page_set.auto_evidence === undefined || typeof page_set.auto_evidence === "boolean")
		&& (page_set.auto_recording === undefined || typeof page_set.auto_recording === "boolean")
		&& typeof page_set.created_at === "string"
		&& typeof page_set.updated_at === "string";
	if (!shared_checks) return false;
	if (page_set.kind === "workflow") return Array.isArray(page_set.steps) && page_set.steps.length > 0 && page_set.steps.every(is_workflow_step);
	if (page_set.kind !== undefined && page_set.kind !== "urls") return false;
	return Array.isArray(page_set.urls) && page_set.urls.every((url) => typeof url === "string");
}

async function load_page_sets(): Promise<Qa_page_set[]> {
	const file = Bun.file(page_sets_path);
	const exists = await file.exists();
	if (!exists) return [];
	const value = await file.json() as unknown;
	if (!Array.isArray(value) || !value.every(is_page_set)) {
		throw new Error(`Invalid ReeQA page set store: ${page_sets_path}`);
	}
	return value;
}

async function persist_page_sets(page_sets: Qa_page_set[]): Promise<void> {
	mkdirSync(qa_config_dir, { recursive: true });
	const body = `${JSON.stringify(page_sets, null, "\t")}\n`;
	await Bun.write(page_sets_path, body);
}

function normalized_name(name_value: string): string {
	const name = name_value.trim();
	if (!name) throw new Error("Page set name is required.");
	if (name.length > 80) throw new Error("Page set name must be at most 80 characters.");
	return name;
}

function normalized_urls(url_values: string[]): string[] {
	const urls = [...new Set(url_values.map((url) => new URL(url).href))];
	urls.sort();
	if (urls.length === 0) throw new Error("Select at least one baseline page.");
	return urls;
}

/**
 * A workflow's navigate targets are checked against the project's own
 * origin, not the sitemap - a login POST target or an admin-only route
 * legitimately isn't in sitemap.xml the way a URL-list page has to be.
 */
function normalized_steps(project: Qa_project, step_values: Workflow_step[]): Workflow_step[] {
	if (step_values.length === 0) throw new Error("Add at least one workflow step.");
	const base_origin = new URL(project.base_url).origin;
	const stray = step_values.find((step) => step.type === "navigate" && new URL(step.url).origin !== base_origin);
	if (stray && stray.type === "navigate") throw new Error(`Workflow steps must stay on ${base_origin} (found ${stray.url}).`);
	return step_values;
}

function normalized_capture_size(width_value: number | undefined, height_value: number | undefined): { capture_width?: number; capture_height?: number; } {
	if (width_value === undefined && height_value === undefined) return {};
	const width = width_value ?? visual_capture_width;
	const height = height_value ?? visual_capture_height;
	if (!Number.isInteger(width) || width < 1 || width > 4096) throw new Error("Capture width must be between 1 and 4096.");
	if (!Number.isInteger(height) || height < 1 || height > 4096) throw new Error("Capture height must be between 1 and 4096.");
	return { capture_width: width, capture_height: height };
}

export async function list_page_sets(project_id?: string): Promise<Qa_page_set[]> {
	const page_sets = await load_page_sets();
	if (!project_id) return page_sets;
	return page_sets.filter((page_set) => page_set.project_id === project_id);
}

export async function find_page_set(page_set_id: string): Promise<Qa_page_set | undefined> {
	const page_sets = await load_page_sets();
	return page_sets.find((page_set) => page_set.id === page_set_id);
}

export async function require_page_set(project_id: string, page_set_id: string): Promise<Qa_page_set> {
	const page_set = await find_page_set(page_set_id);
	if (!page_set || page_set.project_id !== project_id) throw new Error("Page set not found for this QA project.");
	return page_set;
}

export type Page_set_input = {
	name: string;
	kind: "urls" | "workflow";
	urls?: string[];
	steps?: Workflow_step[];
	capture_width?: number;
	capture_height?: number;
	auto_evidence?: boolean;
	auto_recording?: boolean;
};

function kind_specific_fields(project: Qa_project, input: Page_set_input): { kind?: "workflow"; steps: Workflow_step[] } | { urls: string[] } {
	if (input.kind === "workflow") return { kind: "workflow", steps: normalized_steps(project, input.steps ?? []) };
	return { urls: normalized_urls(input.urls ?? []) };
}

export async function create_page_set(project_id: string, input: Page_set_input): Promise<Qa_page_set> {
	const project = await find_project(project_id);
	if (!project) throw new Error("QA project not found.");
	const name = normalized_name(input.name);
	const kind_fields = kind_specific_fields(project, input);
	const capture = normalized_capture_size(input.capture_width, input.capture_height);
	const page_sets = await load_page_sets();
	if (page_sets.some((page_set) => page_set.project_id === project_id && page_set.name.toLowerCase() === name.toLowerCase())) {
		throw new Error("A page set with that name already exists for this project.");
	}
	const now = new Date().toISOString();
	const page_set = {
		id: crypto.randomUUID(),
		project_id,
		name,
		created_at: now,
		updated_at: now,
		...(capture.capture_width === undefined ? {} : { capture_width: capture.capture_width }),
		...(capture.capture_height === undefined ? {} : { capture_height: capture.capture_height }),
		auto_evidence: Boolean(input.auto_evidence),
		auto_recording: Boolean(input.auto_recording),
		...kind_fields,
	} as Qa_page_set;
	page_sets.push(page_set);
	await persist_page_sets(page_sets);
	return page_set;
}

export async function update_page_set(page_set_id: string, input: Page_set_input): Promise<Qa_page_set> {
	const name = normalized_name(input.name);
	const page_sets = await load_page_sets();
	const page_set_index = page_sets.findIndex((page_set) => page_set.id === page_set_id);
	if (page_set_index < 0) throw new Error("Page set not found.");
	const page_set = page_sets[page_set_index]!;
	const project = await find_project(page_set.project_id);
	if (!project) throw new Error("QA project not found.");
	const kind_fields = kind_specific_fields(project, input);
	const capture = normalized_capture_size(input.capture_width, input.capture_height);
	if (page_sets.some((candidate) => candidate.id !== page_set_id
		&& candidate.project_id === page_set.project_id
		&& candidate.name.toLowerCase() === name.toLowerCase())) {
			throw new Error("A page set with that name already exists for this project.");
		}
	const updated_page_set = {
		...page_set,
		name,
		updated_at: new Date().toISOString(),
		...(capture.capture_width === undefined ? {} : { capture_width: capture.capture_width }),
		...(capture.capture_height === undefined ? {} : { capture_height: capture.capture_height }),
		auto_evidence: Boolean(input.auto_evidence),
		auto_recording: Boolean(input.auto_recording),
		// Switching kind must not leave the other kind's field behind - an
		// empty `urls` alongside `steps` (or vice versa) would linger in the
		// stored JSON with nothing left reading it.
		kind: undefined,
		urls: undefined,
		steps: undefined,
		...kind_fields,
	} as Qa_page_set;
	page_sets[page_set_index] = updated_page_set;
	await persist_page_sets(page_sets);
	return updated_page_set;
}

export async function delete_page_set(page_set_id: string): Promise<void> {
	const page_sets = await load_page_sets();
	const page_set = page_sets.find((candidate) => candidate.id === page_set_id);
	if (!page_set) throw new Error("Page set not found.");
	const remaining_page_sets = page_sets.filter((candidate) => candidate.id !== page_set_id);
	await persist_page_sets(remaining_page_sets);
	const active_record = await read_active_page_set();
	if (active_record?.page_set_id === page_set_id) await clear_active_page_set();
}

export async function delete_project_page_sets(project_id: string): Promise<void> {
	const page_sets = await load_page_sets();
	const remaining_page_sets = page_sets.filter((page_set) => page_set.project_id !== project_id);
	if (remaining_page_sets.length === page_sets.length) return;
	await persist_page_sets(remaining_page_sets);
	const active_record = await read_active_page_set();
	if (active_record?.project_id === project_id) await clear_active_page_set();
}

export async function get_active_page_set(project_id: string): Promise<Qa_page_set | undefined> {
	const record = await read_active_page_set();
	if (!record || record.project_id !== project_id) return undefined;
	const page_set = await find_page_set(record.page_set_id);
	if (!page_set || page_set.project_id !== project_id) return undefined;
	return page_set;
}

export async function require_active_page_set(project_id: string): Promise<Qa_page_set> {
	const page_set = await get_active_page_set(project_id);
	if (!page_set) throw new Error("Select a page set first.");
	return page_set;
}

export async function set_active_page_set_id(project_id: string, page_set_id: string): Promise<void> {
	await require_page_set(project_id, page_set_id);
	mkdirSync(qa_config_dir, { recursive: true });
	const body = `${JSON.stringify({ project_id, page_set_id }, null, "\t")}\n`;
	await Bun.write(active_page_set_path, body);
}

export async function clear_active_page_set_selection(): Promise<void> {
	await clear_active_page_set();
}
