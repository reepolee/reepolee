import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { qa_config_dir } from "./config";
import { find_page_set } from "./page_set_store";
import { find_project } from "./project_store";
import { find_active_visual_run, start_visual_run, type Visual_operation } from "./visual_store";

export type Qa_schedule = {
	id: string;
	project_id: string;
	page_set_id: string;
	operation: Visual_operation;
	interval_hours: number;
	last_run_at?: string;
};

const schedules_path = join(qa_config_dir, "schedules.json");
const SCHEDULER_TICK_MS = 60_000;

declare global {
	var __reeqa_scheduler_started: boolean | undefined;
}

function is_schedule(value: unknown): value is Qa_schedule {
	if (!value || typeof value !== "object") return false;
	const schedule = value as Record<string, unknown>;
	return typeof schedule.id === "string"
		&& typeof schedule.project_id === "string"
		&& typeof schedule.page_set_id === "string"
		&& (schedule.operation === "compare" || schedule.operation === "baseline")
		&& typeof schedule.interval_hours === "number"
		&& Number.isInteger(schedule.interval_hours)
		&& schedule.interval_hours >= 1
		&& (schedule.last_run_at === undefined || typeof schedule.last_run_at === "string");
}

async function load_schedules(): Promise<Qa_schedule[]> {
	const file = Bun.file(schedules_path);
	if (!(await file.exists())) return [];
	const value = await file.json() as unknown;
	if (!Array.isArray(value) || !value.every(is_schedule)) {
		throw new Error(`Invalid ReeQA schedule store: ${schedules_path}`);
	}
	return value;
}

async function persist_schedules(schedules: Qa_schedule[]): Promise<void> {
	mkdirSync(qa_config_dir, { recursive: true });
	await Bun.write(schedules_path, `${JSON.stringify(schedules, null, "\t")}\n`);
}

export async function list_schedules(): Promise<Qa_schedule[]> {
	return load_schedules();
}

export async function add_schedule(project_id: string, page_set_id: string, operation: Visual_operation, interval_hours: number): Promise<Qa_schedule> {
	const project = await find_project(project_id);
	if (!project) throw new Error("QA project not found.");
	const page_set = await find_page_set(page_set_id);
	if (!page_set || page_set.project_id !== project.id) throw new Error("Page set does not belong to the project.");
	if (!Number.isInteger(interval_hours) || interval_hours < 1 || interval_hours > 24 * 365) {
		throw new Error("Schedule interval must be a whole number of hours between 1 and 8760.");
	}
	const schedules = await load_schedules();
	const schedule: Qa_schedule = { id: crypto.randomUUID(), project_id, page_set_id, operation, interval_hours };
	schedules.push(schedule);
	await persist_schedules(schedules);
	return schedule;
}

export async function remove_schedule(schedule_id: string): Promise<void> {
	const schedules = await load_schedules();
	const remaining = schedules.filter((schedule) => schedule.id !== schedule_id);
	if (remaining.length === schedules.length) throw new Error("Schedule not found.");
	await persist_schedules(remaining);
}

/**
 * Start any due schedules. A schedule is due once its interval has elapsed
 * since its last attempt. Skips the tick entirely while a visual run is in
 * progress, so a scheduled run never stacks on one that is already running.
 */
export async function run_due_schedules(): Promise<void> {
	const schedules = await load_schedules();
	if (schedules.length === 0) return;
	if (await find_active_visual_run()) return;
	const now = Date.now();
	let changed = false;
	for (const schedule of schedules) {
		const interval_ms = schedule.interval_hours * 3_600_000;
		const last = schedule.last_run_at === undefined ? 0 : Date.parse(schedule.last_run_at);
		if (Number.isNaN(last) || now - last < interval_ms) continue;
		changed = true;
		schedule.last_run_at = new Date().toISOString();
		try {
			await start_visual_run(schedule.project_id, schedule.operation, schedule.page_set_id);
		} catch (error) {
			console.warn(`[reeqa] Scheduled ${schedule.operation} for ${schedule.project_id}/${schedule.page_set_id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (changed) await persist_schedules(schedules);
}

/**
 * Idempotent scheduler loop. The server's own listener keeps the process
 * alive; the unref means importing ReeQA routes in a test or smoke script
 * does not hang on the timer.
 */
export function start_scheduler(): void {
	if (globalThis.__reeqa_scheduler_started) return;
	globalThis.__reeqa_scheduler_started = true;
	void run_due_schedules();
	setInterval(() => { void run_due_schedules(); }, SCHEDULER_TICK_MS).unref();
}
