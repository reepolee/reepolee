import { createWriteStream, mkdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

import { now_time_str, now_today } from "$lib/temporal";

// File appender

export function create_file_logger(path: string) {
	const dir = dirname(path);
	const ext = extname(path);
	const name = basename(path, ext);
	const today = now_today();
	const target_dir = join(dir, name);
	mkdirSync(target_dir, { recursive: true });
	const dated_path = join(target_dir, `${today}${ext}`);
	const stream = createWriteStream(dated_path, { flags: "a" });

	// `user` is supplied by the caller (ctx.user is already resolved per
	// request) - the logger never touches the session store itself.
	return (data: string | {}, user?: string | null) => {
		let entries: any = {};
		if (typeof data === "string") {
			entries.s = data;
		} else {
			entries = data;
		}

		const entry: any = {
			ts: now_time_str(true),
			u: user || "--anonymous",
			...entries,
		};

		stream.write(`${JSON.stringify(entry)}\n`);
	};
}

// Structured console logger

// Log an INFO-level message with optional structured data.
export function log_info(component: string, msg: string, data?: Record<string, unknown>): void {
	const ts = now_time_str();
	if (data) {
		console.log(`[${ts}] [INFO] [${component}] ${msg}`, JSON.stringify(data));
	} else {
		console.log(`[${ts}] [INFO] [${component}] ${msg}`);
	}
}

// Log a WARN-level message with optional structured data.
export function log_warn(component: string, msg: string, data?: Record<string, unknown>): void {
	const ts = now_time_str();
	if (data) {
		console.warn(`[${ts}] [WARN] [${component}] ${msg}`, JSON.stringify(data));
	} else {
		console.warn(`[${ts}] [WARN] [${component}] ${msg}`);
	}
}

// Log an ERROR-level message with error info and optional structured data.
export function log_error(component: string, msg: string, err?: unknown, data?: Record<string, unknown>): void {
	const ts = now_time_str();
	const err_info: Record<string, unknown> = {};
	if (err instanceof Error) {
		err_info.message = err.message;
		err_info.stack = err.stack?.split("\n").slice(0, 4).join("|");
	} else if (err != null) {
		err_info.message = String(err);
	}
	console.error(`[${ts}] [ERROR] [${component}] ${msg}`, JSON.stringify({ ...err_info, ...data }));
}

// Return a human-readable duration string from a process.hrtime.bigint() start value.
export function duration_ms(start: bigint): string { return `${(Number(process.hrtime.bigint() - start) / 1_000_000).toFixed(2)}ms`; }

/**
 * SQL query logger - logs to ./logs/sql.ndjson when SQL_LOGGING=true.
 * No-op otherwise (empty function).
 */
export const sql_log = Bun.env.SQL_LOGGING === "true" ? create_file_logger("./logs/sql.ndjson") : () => {};
