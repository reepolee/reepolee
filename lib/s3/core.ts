/**
 * S3 Core - shared functions used by both lib/s3.ts and lib/s3/proxy.ts.
 * Extracted to break the circular import: $lib/s3 -> ./s3/proxy -> $lib/s3.
 */

import { get_storage_mode, require_env, sanitize_env_value } from "$lib/env";
import { duration_ms, log_info } from "$lib/logger";
import type { S3File, S3Options } from "bun";
import { S3Client } from "bun";

// ---------------------------------------------------------------------------
// S3 credential resolution
// ---------------------------------------------------------------------------

function read_s3_env(key: string): string {
	const raw = Bun.env[key] || "";
	return sanitize_env_value(raw);
}

function resolve_s3_endpoint(): string {
	const protocol = read_s3_env("S3_PROTOCOL");
	const hostname = read_s3_env("S3_HOSTNAME");
	const port = read_s3_env("S3_PORT");

	if (!hostname) return "";
	return `${protocol || "http"}://${hostname}${port ? `:${port}` : ""}`;
}

function resolve_s3_access_key(): string { return read_s3_env("S3_ACCESS_KEY_ID"); }

function resolve_s3_secret_key(): string { return read_s3_env("S3_SECRET_ACCESS_KEY"); }

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

// Whether S3 credentials are fully configured (graceful - returns false if not).
export function is_s3_configured(): boolean {
	const mode = get_storage_mode();
	if (mode === "local") return false;
	if (mode === "s3") {
		const configured = !!(resolve_s3_access_key() && resolve_s3_secret_key() && resolve_s3_endpoint());
		if (!configured) {
			console.error("\u001b[31m✗ STORAGE=s3 but S3 credentials are not fully configured\u001b[0m");
			console.error("  Set S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, and S3_HOSTNAME env vars.");
			process.exit(1);
		}
		return true;
	}
	// Auto-detect (backwards compatible)
	return !!(resolve_s3_access_key() && resolve_s3_secret_key() && resolve_s3_endpoint());
}

/**
 * Create an S3Client for a specific bucket.
 * Throws via require_env if S3 credentials are not configured.
 */
export function s3_client(bucket: string): S3Client {
	const access_key = require_env("S3_ACCESS_KEY_ID");
	const secret_key = require_env("S3_SECRET_ACCESS_KEY");
	// Build the endpoint from the detailed S3_HOSTNAME/S3_PORT/S3_PROTOCOL fields
	// (same resolver is_s3_configured uses). Fails loud if S3_HOSTNAME is not set.
	const endpoint = resolve_s3_endpoint();
	if (!endpoint) {
		console.error("\u001b[31m✗ Required S3 endpoint is not configured\u001b[0m");
		console.error("  Set S3_HOSTNAME (with optional S3_PORT/S3_PROTOCOL) env vars.");
		process.exit(1);
	}
	const region = read_s3_env("S3_REGION");
	const display = endpoint.replace(/\/+$/, "");

	log_info("s3", "s3_client: creating", { bucket, endpoint: display, region: region || "" });
	return new S3Client({
		accessKeyId: access_key,
		secretAccessKey: secret_key,
		endpoint,
		...(region ? { region } : {}),
		bucket,
	});
}

// Display-friendly endpoint (strip trailing slash).
export function display_endpoint(): string { return resolve_s3_endpoint().replace(/\/+$/, ""); }

// Get a lazy S3File reference for the given bucket and key.
export function s3_file(bucket: string, key: string, options?: S3Options): S3File { return s3_client(bucket).file(key, options); }

/**
 * Upload data to S3, auto-creating the bucket if it doesn't exist.
 */
export async function save_to_s3(bucket: string, key: string, data: Parameters<S3File["write"]>[0], options?: S3Options): Promise<void> {
	const start = process.hrtime.bigint();
	const file = s3_file(bucket, key, options);
	const size = typeof data === "object" && data !== null && "size" in data ? (data as { size: number; }).size : typeof data === "string" ? data.length : "?";
	log_info("s3", "save_to_s3: starting", {
		bucket,
		key,
		size,
		endpoint: display_endpoint(),
		content_type: options?.type,
	});
	await file.write(data);
	log_info("s3", "save_to_s3: complete", { bucket, key, size, duration: duration_ms(start) });
}
