import { duration_ms, log_info } from "$lib/logger";

/**
 * Execute an async SQL operation, log its duration, and return the result.
 *
 * @param component - The logical component name for logging (e.g. "partners", "goriva").
 * @param label     - A short label identifying the operation (e.g. "get_all_records").
 * @param fn        - The async function that performs the SQL query(ies).
 * @param extra     - Optional static extra data **or** a function that derives extra
 * data from the result (e.g. `(r) => ({ count: r.length })`).
 *
 * @example
 * ```ts
 * const records = await timed_query("partners", "get_all_records",
 * () => db`SELECT * FROM partners ORDER BY id ASC`,
 * (r) => ({ count: r.length }),
 * );
 * ```
 *
 * @example
 * ```ts
 * await timed_query("partners", "update_record",
 * () => db`UPDATE partners SET title = ${title} WHERE id = ${id}`,
 * { id },
 * );
 * ```
 */
export async function timed_query<T>(component: string, label: string, fn: () => Promise<T>, extra?: Record<string, unknown> | ((result: T) => Record<string, unknown>)): Promise<T> {
	const start = process.hrtime.bigint();
	const result = await fn();
	const data: Record<string, unknown> = { duration: duration_ms(start) };

	if (typeof extra === "function") {
		Object.assign(data, extra(result));
	} else if (extra) {
		Object.assign(data, extra);
	}

	log_info(component, label, data);
	return result;
}
