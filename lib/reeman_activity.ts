/**
 * Cross-process signal that a Reeman action is writing generated files.
 *
 * The Reeman UI persists its busy entries because generator subprocesses and
 * Bun's hot-reload process do not share memory. Dev servers use the same file
 * to defer watcher-driven route rebuilds until the action's explicit final
 * reload, avoiding a rebuild for every generated file.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const STATE_FILE = join(process.cwd(), ".reepolee", "reeman-busy.json");
const WRITE_DIR = join(process.cwd(), ".reepolee", "reeman-writes");
const MAX_AGE_MS = 20 * 60 * 1000;

type BusyEntry = { pid?: unknown; started?: unknown; };

function process_is_running(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function is_reeman_action_active(): Promise<boolean> {
	try {
		const file = Bun.file(STATE_FILE);
		if (!(await file.exists())) return false;
		const entries: unknown = JSON.parse(await file.text());
		if (!entries || typeof entries !== "object" || Array.isArray(entries)) return false;
		for (const entry of Object.values(entries as Record<string, BusyEntry>)) {
			if (typeof entry.started !== "string") continue;
			const started_at = Date.parse(entry.started);
			if (!Number.isNaN(started_at) && Date.now() - started_at <= MAX_AGE_MS && process_is_running(entry.pid)) return true;
		}
	} catch {
		// A busy-state read must never prevent a normal dev hot reload.
	}
	try {
		for (const marker of readdirSync(WRITE_DIR)) {
			const marker_path = join(WRITE_DIR, marker);
			const entry: BusyEntry = JSON.parse(await Bun.file(marker_path).text());
			if (typeof entry.started !== "string") continue;
			const started_at = Date.parse(entry.started);
			if (!Number.isNaN(started_at) && Date.now() - started_at <= MAX_AGE_MS && process_is_running(entry.pid)) return true;
			rmSync(marker_path, { force: true });
		}
	} catch {
		// No active writer marker is normal.
	}
	return false;
}

/**
 * Suppress watcher-driven route rebuilds while a non-action Reeman request
 * refreshes generated metadata (the route editor's schema sync).
 */
export async function with_reeman_file_writes<T>(work: () => Promise<T>): Promise<T> {
	mkdirSync(WRITE_DIR, { recursive: true });
	const marker_path = join(WRITE_DIR, `${process.pid}-${randomUUID()}.json`);
	await Bun.write(marker_path, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
	try {
		return await work();
	} finally {
		// Give Bun's watcher a brief opportunity to observe the marker before it
		// is removed; the route editor itself does not need a route-table reload.
		await Bun.sleep(750);
		rmSync(marker_path, { force: true });
	}
}
