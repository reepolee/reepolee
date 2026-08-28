/**
 * Per-target busy tracking for the reeman web UI.
 *
 * CRUD generation runs one table at a time, but different tables are
 * independent: generating "sessions" must not block starting "files". A
 * single global flag (the original design) prevented that, so busy state is
 * now keyed by target - a table name for single-table CRUD, one key per
 * table for a bulk run, or a fixed "__global__" key for actions that touch
 * shared state (translations sync, SQL file execution, locale changes) and
 * so must stay exclusive against every other action, per-table or global.
 *
 * Persisted to .reepolee/ (same directory reeman's run log and session
 * replay files use) because generator actions write apps/main/ files and
 * trigger `bun --hot` restarts, which would otherwise wipe an in-memory Map
 * mid-generation - the same reason lib/state.ts's run log is file-backed.
 *
 * A stale entry (owning process crashed instead of exiting cleanly) self-heals
 * two ways. First, every entry records the pid of the process that set it, so
 * after a cold restart (which orphans any in-flight subprocess and its onExit
 * cleanup) a foreign-pid entry is treated as not busy immediately rather than
 * wedging the UI for the full timeout. Second, MAX_AGE_MS still catches an
 * entry from the *same* process that hung instead of clearing.
 */

import { join } from "node:path";

const STATE_FILE = join(process.cwd(), ".reepolee", "reeman-busy.json");
const MAX_AGE_MS = 20 * 60 * 1000; // matches busy-poller's 20-minute cap

export const GLOBAL_BUSY_KEY = "__global__";

export type BusyEntry = { action: string; target: string; started: string; pid: number; };

async function read_all(file: string = STATE_FILE): Promise<Record<string, BusyEntry>> {
	try {
		const file_handle = Bun.file(file);
		if (!(await file_handle.exists())) return {};
		const parsed: unknown = JSON.parse(await file_handle.text());
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as Record<string, BusyEntry>;
	} catch {
		return {};
	}
}

async function write_all(entries: Record<string, BusyEntry>, file: string = STATE_FILE): Promise<void> {
	try {
		await Bun.write(file, JSON.stringify(entries, null, 2));
	} catch {
		// best-effort - a failed write just means the busy banner may lag
	}
}

function is_stale(entry: BusyEntry): boolean {
	// Owned by a previous process lifecycle (cold restart). Hot reloads keep
	// the same pid, so an in-flight action still reads as busy across them;
	// a fresh process owns nothing, so a foreign pid is always stale.
	if (typeof entry.pid === "number" && entry.pid !== process.pid) return true;

	const started = Date.parse(entry.started);
	if (Number.isNaN(started)) return true;
	return Date.now() - started > MAX_AGE_MS;
}

/**
 * Drop entries that `is_stale()` already ignores, so the file does not keep
 * them forever.
 *
 * Reads self-heal without this - a stale entry never reads as busy and can be
 * re-acquired - but nothing ever removed one from disk. A spawned action's
 * onExit is the only writer that clears, and it dies with its process, so a
 * cold restart (or a killed server) orphans the entry permanently. Pruning on
 * write keeps .reepolee/reeman-busy.json from accumulating dead keys that make
 * the file look like work is in flight when nothing is.
 */
function prune_stale(entries: Record<string, BusyEntry>): { pruned: Record<string, BusyEntry>; removed: number; } {
	const pruned: Record<string, BusyEntry> = {};
	let removed = 0;
	for (const [key, entry] of Object.entries(entries)) {
		if (is_stale(entry)) {
			removed++;
			continue;
		}
		pruned[key] = entry;
	}
	return { pruned, removed };
}

/**
 * Mark `key` busy. Returns false without writing if `key` (or the global key)
 * is already busy - callers should treat that as "action rejected".
 */
export async function set_busy(key: string, entry: { action: string; target: string; }, file: string = STATE_FILE): Promise<boolean> {
	const entries = await read_all(file);
	for (const k of [key, GLOBAL_BUSY_KEY]) {
		const existing = entries[k];
		if (existing && !is_stale(existing)) return false;
	}
	const { pruned } = prune_stale(entries);
	pruned[key] = { ...entry, started: new Date().toISOString(), pid: process.pid };
	await write_all(pruned, file);
	return true;
}

/** Clear one busy key (called from a spawned action's onExit). */
export async function clear_busy(key: string, file: string = STATE_FILE): Promise<void> {
	const entries = await read_all(file);
	if (!(key in entries)) return;
	delete entries[key];
	await write_all(entries, file);
}

/**
 * Current busy entry for `key`, or the global lock if that is set instead.
 * Omit `key` to check only the global lock (used by actions that are always
 * exclusive, e.g. sync-translations, run-sql-file).
 */
export async function get_busy(key: string = GLOBAL_BUSY_KEY, file: string = STATE_FILE): Promise<BusyEntry | null> {
	const entries = await read_all(file);
	const own = entries[key];
	if (own && !is_stale(own)) return own;
	if (key !== GLOBAL_BUSY_KEY) {
		const global = entries[GLOBAL_BUSY_KEY];
		if (global && !is_stale(global)) return global;
	}
	return null;
}

/** Whether anything at all is busy (any table, any global action). Used by pages that show a generic "something is running" banner. */
export async function any_busy(file: string = STATE_FILE): Promise<BusyEntry | null> {
	const entries = await read_all(file);
	const { pruned, removed } = prune_stale(entries);
	// The busy poller calls this on a timer, so it is the one read that reliably
	// runs after a restart even when no new action is ever started. Rewrite only
	// when something was actually dropped - an idle poll must not churn the file.
	if (removed > 0) await write_all(pruned, file);

	for (const entry of Object.values(pruned)) {
		return entry;
	}
	return null;
}

export async function clear_all_busy(file: string = STATE_FILE): Promise<void> {
	await write_all({}, file);
}
