/**
 * Last-run log for the reeman web UI.
 *
 * Generator actions restart the dev server (they write apps/main/ files and
 * append the reload stamp), which wipes in-memory state. The log therefore
 * lives in a small JSON file under .reepolee/ - the same directory reeman's
 * session replay files use - so the last runs (with captured output) survive
 * restarts and are shown on the /reeman page.
 */

import { join } from "node:path";

const STATE_FILE = join(process.cwd(), ".reepolee", "reeman-web-state.json");
const MAX_RUNS = 12;
const MAX_OUTPUT_CHARS = 60_000;

export type RunRecord = {
	id: string;
	action: string;
	target: string;
	ok: boolean;
	started: string;
	finished: string;
	output: string;
	error?: string;
	meta?: Record<string, any>;
};

/**
 * Read the run log. The file path is overridable so tests can use a temp file.
 */
export async function load_runs(file: string = STATE_FILE): Promise<RunRecord[]> {
	try {
		const file_handle = Bun.file(file);
		if (!(await file_handle.exists())) return [];
		const parsed: unknown = JSON.parse(await file_handle.text());
		if (!Array.isArray(parsed)) return [];
		return parsed.slice(0, MAX_RUNS) as RunRecord[];
	} catch {
		return [];
	}
}

/**
 * Captured CLI output can contain literal "<script...>" / "</script>" text
 * (e.g. generated HTML echoed by a failed reload). The dev layout embeds the
 * full page data as JSON inside an inline <script> tag - an unescaped
 * "</script" there closes the tag early and spills the rest of the JSON as
 * visible page text. Break up the sequence so it can't terminate a tag.
 */
function sanitize_output(output: string): string {
	return output.replace(/<\/script/gi, "<\\/script");
}

export async function record_run(
	entry: {
		action: string;
		target: string;
		ok: boolean;
		output: string;
		error?: string;
		meta?: Record<string, any>;
	},
	file: string = STATE_FILE,
): Promise<string> {
	const started = new Date();
	const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const runs = await load_runs(file);
	runs.unshift({
		id,
		action: entry.action,
		target: entry.target,
		ok: entry.ok,
		started: started.toISOString(),
		finished: new Date().toISOString(),
		output: sanitize_output(entry.output.slice(-MAX_OUTPUT_CHARS)),
		error: entry.error,
		meta: entry.meta,
	});
	try {
		await Bun.write(file, JSON.stringify(runs.slice(0, MAX_RUNS), null, 2));
	} catch {
		// best-effort - the toast still confirms the result
	}
	return id;
}

/** Update a previously recorded run after a background action completes. */
export async function update_run(
	id: string,
	entry: {
		ok: boolean;
		output: string;
		error?: string;
		meta?: Record<string, any>;
	},
	file: string = STATE_FILE,
): Promise<void> {
	const runs = await load_runs(file);
	const index = runs.findIndex((run) => run.id === id);
	if (index < 0) return;

	const existing = runs[index];
	if (!existing) return;
	runs[index] = {
		...existing,
		ok: entry.ok,
		finished: new Date().toISOString(),
		output: sanitize_output(entry.output.slice(-MAX_OUTPUT_CHARS)),
		error: entry.error,
		meta: entry.meta ?? existing.meta,
	};
	try {
		await Bun.write(file, JSON.stringify(runs.slice(0, MAX_RUNS), null, 2));
	} catch {
		// best-effort - the completed action has already finished
	}
}

export async function clear_runs(file: string = STATE_FILE): Promise<void> {
	try {
		await Bun.write(file, "[]");
	} catch {
		// best-effort
	}
}
