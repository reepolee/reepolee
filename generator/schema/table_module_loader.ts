type WorkerResult = {
	ok: boolean;
	module_data?: Record<string, unknown>;
	error?: string;
};

/**
 * Load schema exports in an isolated module graph.
 *
 * Bun caches file imports by canonical path and ignores URL query parameters.
 * A short-lived worker has a fresh module graph, so a CRUD refresh reads the
 * table.ts contents just written by schema regeneration without restarting the
 * Reeman server.
 */
export async function load_table_module_fresh<T>(table_path: string): Promise<T> {
	const worker_url = new URL("./table_module_worker.ts", import.meta.url);

	return await new Promise<T>((resolve, reject) => {
		const worker = new Worker(worker_url.href);

		worker.onmessage = (event: MessageEvent<WorkerResult>) => {
			worker.terminate();
			const result = event.data;
			if (!result.ok || !result.module_data) {
				reject(new Error(result.error || `Could not load table module: ${table_path}`));
				return;
			}
			resolve(result.module_data as T);
		};

		worker.onerror = (event: ErrorEvent) => {
			worker.terminate();
			reject(new Error(event.message || `Could not load table module: ${table_path}`));
		};

		worker.postMessage(table_path);
	});
}
