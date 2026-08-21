/**
 * Short-lived scan snapshots for the Reesync review flow.
 *
 * The review page never trusts absolute paths, hashes, or selection state
 * posted by the browser beyond a relative path + scan id: apply/diff always
 * re-resolve both against the snapshot recorded here at scan time.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ScanEntry, ScanSnapshot } from "./types";

const SNAPSHOT_DIR = join(process.cwd(), ".reepolee", "reesync");
const SNAPSHOT_TTL_MS = 30 * 60 * 1000;

function snapshot_path(scan_id: string, dir: string = SNAPSHOT_DIR): string {
	return join(dir, `${scan_id}.json`);
}

export function generate_scan_id(): string {
	return crypto.randomUUID();
}

export async function save_snapshot(snapshot: ScanSnapshot, dir: string = SNAPSHOT_DIR): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(snapshot_path(snapshot.scan_id, dir), JSON.stringify(snapshot), "utf8");
}

export async function load_snapshot(scan_id: string, dir: string = SNAPSHOT_DIR): Promise<ScanSnapshot | null> {
	if (!/^[a-zA-Z0-9-]+$/.test(scan_id)) return null;
	try {
		const text = await readFile(snapshot_path(scan_id, dir), "utf8");
		const parsed = JSON.parse(text) as ScanSnapshot;
		if (is_expired(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function is_expired(snapshot: ScanSnapshot): boolean {
	const created = Date.parse(snapshot.created_at);
	if (Number.isNaN(created)) return true;
	return Date.now() - created > SNAPSHOT_TTL_MS;
}

export async function delete_snapshot(scan_id: string, dir: string = SNAPSHOT_DIR): Promise<void> {
	try {
		await rm(snapshot_path(scan_id, dir));
	} catch {
		// already gone
	}
}

export function find_entry(snapshot: ScanSnapshot, rel_path: string): ScanEntry | null {
	return snapshot.entries.find((entry) => entry.rel_path === rel_path) ?? null;
}

/** Best-effort cleanup of expired snapshot files, called opportunistically on scan. */
export async function prune_expired_snapshots(dir: string = SNAPSHOT_DIR): Promise<void> {
	let files: string[];
	try {
		files = await readdir(dir);
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const text = await readFile(join(dir, file), "utf8");
			const parsed = JSON.parse(text) as ScanSnapshot;
			if (is_expired(parsed)) await rm(join(dir, file));
		} catch {
			// ignore unreadable/corrupt files
		}
	}
}
