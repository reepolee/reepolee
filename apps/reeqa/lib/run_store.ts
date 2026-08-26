import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { enqueue } from "$queue/index";

import { qa_runtime_dir, type Qa_suite } from "./config";
import { announce_run_complete } from "./notify";
import { find_project, require_project_suite } from "./project_store";

export type Qa_run_status = "queued" | "running" | "canceling" | "passed" | "failed" | "canceled";

export type Qa_run = {
	id: string;
	project_id: string;
	project_name: string;
	project_path: string;
	suite_code: string;
	suite_name: string;
	command: string[];
	status: Qa_run_status;
	started_at: string;
	finished_at?: string;
	duration_ms?: number;
	exit_code?: number;
	output: string;
};

type Stored_qa_run = Omit<Qa_run, "project_id" | "project_name" | "project_path"> & {
	project_id?: string;
	project_name?: string;
	project_path?: string;
};

type Qa_process = Bun.Subprocess<"ignore", "pipe", "pipe">;

type Qa_runtime = {
	initialized: boolean;
	runs: Qa_run[];
	processes: Map<string, Qa_process>;
};

declare global {
	var __reeqa_runtime: Qa_runtime | undefined;
}

const runtime_dir = qa_runtime_dir;
const runs_path = join(runtime_dir, "runs.json");
const output_limit = 2_000_000;

function get_runtime(): Qa_runtime {
	if (!globalThis.__reeqa_runtime) {
		globalThis.__reeqa_runtime = {
			initialized: false,
			runs: [],
			processes: new Map(),
		};
	}
	return globalThis.__reeqa_runtime;
}

function is_run_status(value: unknown): value is Qa_run_status {
	return value === "queued"
		|| value === "running"
		|| value === "canceling"
		|| value === "passed"
		|| value === "failed"
		|| value === "canceled";
}

function is_stored_qa_run(value: unknown): value is Stored_qa_run {
	if (!value || typeof value !== "object") return false;
	const run = value as Record<string, unknown>;
	return typeof run.id === "string"
		&& (run.project_id === undefined || typeof run.project_id === "string")
		&& (run.project_name === undefined || typeof run.project_name === "string")
		&& (run.project_path === undefined || typeof run.project_path === "string")
		&& typeof run.suite_code === "string"
		&& typeof run.suite_name === "string"
		&& Array.isArray(run.command)
		&& is_run_status(run.status)
		&& typeof run.started_at === "string"
		&& typeof run.output === "string";
}

function project_run_from_store(run: Stored_qa_run): Qa_run | undefined {
	if (!run.project_id || !run.project_name || !run.project_path) return undefined;
	return {
		...run,
		project_id: run.project_id,
		project_name: run.project_name,
		project_path: run.project_path,
	};
}

async function initialize_runtime(): Promise<Qa_runtime> {
	const runtime = get_runtime();
	if (runtime.initialized) return runtime;
	let store_changed = false;

	const runs_file = Bun.file(runs_path);
	const exists = await runs_file.exists();
	if (exists) {
		const saved_runs = await runs_file.json() as unknown;
		if (!Array.isArray(saved_runs) || !saved_runs.every(is_stored_qa_run)) {
			throw new Error(`Invalid ReeQA run store: ${runs_path}`);
		}
		// "video-e2e" is a retired run type (the Playwright-backed harness);
		// stale records from before its removal are dropped rather than migrated.
		const live_runs = saved_runs.filter((run) => run.suite_code !== "video-e2e");
		if (live_runs.length !== saved_runs.length) store_changed = true;
		runtime.runs = live_runs.flatMap((run) => {
			const clean_output = Bun.stripANSI(run.output);
			if (clean_output !== run.output) store_changed = true;
			const project_run = project_run_from_store({ ...run, output: clean_output });
			if (!project_run) store_changed = true;
			return project_run ? [project_run] : [];
		});
	}

	// Runs are executed by the queue worker (or in-process as a fallback), so a
	// stale "running"/"queued" run here is NOT dead: the worker re-claims the
	// job and re-executes it (see execute_command_run). Marking it failed on
	// boot would race the live worker, so nothing is changed here.

	runtime.initialized = true;
	if (store_changed) await persist_runs(runtime);
	return runtime;
}

/**
 * Re-read runs.json into this process's runtime. See the matching comment in
 * visual_store.ts: initialize_runtime() only loads once per process, but the
 * web server and the queue worker are separate processes each advancing
 * their own copy, so read paths refresh from disk on every call. A run this
 * process is itself driving (tracked in `processes`) is kept from memory.
 */
async function refresh_runtime(): Promise<Qa_runtime> {
	const runtime = await initialize_runtime();
	const runs_file = Bun.file(runs_path);
	if (!(await runs_file.exists())) return runtime;
	const saved_runs = await runs_file.json() as unknown;
	if (!Array.isArray(saved_runs) || !saved_runs.every(is_stored_qa_run)) return runtime;
	runtime.runs = saved_runs.flatMap((disk_run) => {
		if (!runtime.processes.has(disk_run.id)) {
			const project_run = project_run_from_store(disk_run);
			return project_run ? [project_run] : [];
		}
		const current_run = runtime.runs.find((run) => run.id === disk_run.id);
		if (current_run) return [current_run];
		const project_run = project_run_from_store(disk_run);
		return project_run ? [project_run] : [];
	});
	return runtime;
}

async function persist_runs(runtime: Qa_runtime): Promise<void> {
	mkdirSync(runtime_dir, { recursive: true });
	const body = `${JSON.stringify(runtime.runs, null, "\t")}\n`;
	// See the matching comment in visual_store.ts: this file is written by both
	// the web server and the queue worker process, so the write must be atomic.
	const tmp_path = `${runs_path}.${process.pid}.${Date.now()}.tmp`;
	await Bun.write(tmp_path, body);
	renameSync(tmp_path, runs_path);
}

function append_output(run: Qa_run, text: string): void {
	const clean_text = Bun.stripANSI(text);
	const combined = `${run.output}${clean_text}`;
	if (combined.length <= output_limit) {
		run.output = combined;
		return;
	}
	const start = combined.length - output_limit;
	run.output = `[Earlier output omitted]\n${combined.slice(start)}`;
}

async function consume_stream(stream: ReadableStream<Uint8Array>, run: Qa_run): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		append_output(run, decoder.decode(result.value, { stream: true }));
	}
	const remaining = decoder.decode();
	if (remaining) append_output(run, remaining);
}

async function complete_run(run: Qa_run, process: Qa_process, runtime: Qa_runtime): Promise<void> {
	const stdout_done = consume_stream(process.stdout, run);
	const stderr_done = consume_stream(process.stderr, run);
	const exit_code = await process.exited;
	await Promise.all([stdout_done, stderr_done]);

	if (run.status === "canceling") run.status = "canceled";
	else run.status = exit_code === 0 ? "passed" : "failed";

	run.exit_code = exit_code;
	run.finished_at = new Date().toISOString();
	run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
	runtime.processes.delete(run.id);
	await persist_runs(runtime);
	announce_command_completion(run);
}

function announce_command_completion(run: Qa_run): void {
	if (run.status === "canceled") return;
	if (run.status === "passed") {
		void announce_run_complete(`Command check passed: ${run.suite_name}.`, true);
	} else {
		void announce_run_complete(`Command check failed: ${run.suite_name}.`, false);
	}
}

function command_for_display(suite: Qa_suite): string[] {
	return [...suite.command];
}

export async function list_runs(): Promise<Qa_run[]> {
	const runtime = await refresh_runtime();
	return [...runtime.runs];
}

export async function find_run(run_id: string): Promise<Qa_run | undefined> {
	const runtime = await refresh_runtime();
	return runtime.runs.find((run) => run.id === run_id);
}

export async function find_running_run(): Promise<Qa_run | undefined> {
	const runtime = await refresh_runtime();
	return runtime.runs.find((run) => run.status === "running" || run.status === "queued" || run.status === "canceling");
}

async function start_command_run(project_id: string, project_name: string, project_path: string, suite_code: string, suite_name: string, command_value: readonly string[]): Promise<Qa_run> {
	const runtime = await refresh_runtime();
	const active_run = await find_running_run();
	if (active_run) throw new Error(`${active_run.suite_name} is already running.`);
	const command = [...command_value];

	const run: Qa_run = {
		id: crypto.randomUUID(),
		project_id,
		project_name,
		project_path,
		suite_code,
		suite_name,
		command,
		status: "queued",
		started_at: new Date().toISOString(),
		output: "",
	};
	runtime.runs.unshift(run);
	await persist_runs(runtime);

	// Execute through the queue worker when available, falling back to
	// in-process execution (the pre-queue behavior) when it is not.
	try {
		await enqueue({ type: "reeqa_suite_run", payload: { run_id: run.id } });
	} catch (error) {
		console.warn(`[reeqa] Queue unavailable - executing suite run ${run.id} in-process: ${error instanceof Error ? error.message : String(error)}`);
		void execute_command_run(run.id);
	}

	return run;
}

/**
 * Execute a suite run's command: spawn the subprocess, stream its output into
 * the run record, and mark it complete. Runs in the queue worker (registered
 * as `reeqa_suite_run` in workers.ts) - or in-process as a fallback when the
 * queue is unavailable. Re-executes a stale "running"/"queued" run (e.g. a
 * job re-claimed after a worker crash); completed runs are left untouched.
 */
export async function execute_command_run(run_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) throw new Error(`Unknown QA run: ${run_id}`);
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

	try {
		const process = Bun.spawn(run.command, {
			cwd: run.project_path,
			env: { ...Bun.env, CI: "1", NO_COLOR: "1" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		runtime.processes.set(run.id, process);
		await persist_runs(runtime);
		await complete_run(run, process, runtime);
	} catch (error) {
		run.status = "failed";
		run.finished_at = new Date().toISOString();
		run.duration_ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
		const error_message = error instanceof Error ? error.message : String(error);
		run.output = Bun.stripANSI(error_message);
		await persist_runs(runtime);
		announce_command_completion(run);
	}
}

export async function start_run(project_id: string, suite_code: string): Promise<Qa_run> {
	const project_suite = await require_project_suite(project_id, suite_code);
	const project = project_suite.project;
	const suite = project_suite.suite;
	const command = command_for_display(suite);
	return start_command_run(project.id, project.name, project.path, suite.code, suite.name, command);
}

export async function start_external_run(project_id: string, suite_code: string, suite_name: string, working_directory: string, command: readonly string[]): Promise<Qa_run> {
	const project = await find_project(project_id);
	if (!project) throw new Error("QA project not found.");
	return start_command_run(project.id, project.name, working_directory, suite_code, suite_name, command);
}

export async function cancel_run(run_id: string): Promise<Qa_run> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) throw new Error(`Unknown QA run: ${run_id}`);
	if (run.status === "passed" || run.status === "failed" || run.status === "canceled") {
		throw new Error("Only a running QA suite can be canceled.");
	}
	if (run.status !== "canceling") {
		run.status = "canceling";
		await persist_runs(runtime);
	}

	// The subprocess lives in the queue worker - ask it to kill it. Falls back
	// to a direct kill when the queue is unavailable (in-process execution).
	try {
		await enqueue({ type: "reeqa_cancel", payload: { run_id, kind: "suite" } });
	} catch (error) {
		const process = runtime.processes.get(run_id);
		if (process) process.kill("SIGTERM");
	}
	return run;
}

/**
 * Kill a run's subprocess from the queue worker (the reeqa_cancel handler).
 * The server sets the status to "canceling" before enqueueing; this mirrors
 * that on the worker's own in-memory record and terminates the process, so
 * the completion logic finalizes the run as "canceled".
 */
export async function cancel_run_in_worker(run_id: string): Promise<void> {
	const runtime = await refresh_runtime();
	const run = runtime.runs.find((item) => item.id === run_id);
	if (!run) return;
	if (run.status === "passed" || run.status === "failed" || run.status === "canceled") return;
	if (run.status !== "canceling") {
		run.status = "canceling";
		await persist_runs(runtime);
	}
	const process = runtime.processes.get(run_id);
	if (process) process.kill("SIGTERM");
}

export async function clear_completed_runs(project_id?: string): Promise<number> {
	const runtime = await refresh_runtime();
	const before = runtime.runs.length;
	runtime.runs = runtime.runs.filter((run) => {
		const is_active = run.status === "running" || run.status === "queued" || run.status === "canceling";
		if (is_active) return true;
		return project_id !== undefined && run.project_id !== project_id;
	});
	await persist_runs(runtime);
	return before - runtime.runs.length;
}
