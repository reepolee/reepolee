/**
 * Server helpers - shared logic extracted from server.ts for cleanliness and testability.
 *
 * These are pure(ish) utility functions used by both the dev and prod fetch handlers,
 * plus common endpoint handling shared across routing modes.
 */

import os from "node:os";
import { join } from "node:path";

import { handle_rate_limits_get, handle_rate_limits_reset } from "$lib/admin/rate_limits";
import { handle_reload_translations } from "$lib/admin/reload_translations";
import { internal_admin_endpoints_enabled } from "$lib/admin/require_admin_auth";
import { get_storage_mode } from "$lib/env";
import { translations } from "$lib/i18n";
import { get_local_storage_dir } from "$lib/local_storage";
import type { RouteTable } from "$lib/middleware/types";
import { kill_port } from "$lib/port_release";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { get_s3_mounts, handle_s3_request, is_s3_configured } from "$lib/s3";
import { listen_for_open_key } from "$lib/server_controls";

// ---------------------------------------------------------------------------
// Internal admin / debug endpoints
// ---------------------------------------------------------------------------

/**
 * Handle internal API endpoints (admin/debug routes that start with __).
 * These need to be checked before normal route matching in both dev and prod modes.
 *
 * Returns an endpoint response if the URL matches, or null to continue.
 */
export function handle_internal_endpoints(req: Request, url: URL): Response | Promise<Response> | null {
	if (!internal_admin_endpoints_enabled()) return null;

	if (req.method === "POST" && url.pathname === "/__reload-translations") { return handle_reload_translations(req); }

	if (req.method === "GET" && url.pathname === "/__rate-limits") { return handle_rate_limits_get(req); }

	if (req.method === "POST" && url.pathname === "/__reset-rate-limits") { return handle_rate_limits_reset(req); }

	return null;
}

// ---------------------------------------------------------------------------
// Shared fallback handling (S3 / local storage / static files / 404)
// ---------------------------------------------------------------------------

/**
 * Handle path resolution for a matched route handler - could be a plain
 * function or a method map ({ GET: fn, POST: fn }). Attaches `params` to
 * `req.params` so handlers can read :param segments (matches Bun's native
 * radix-tree behaviour).
 *
 * If the request carries Accept: application/json and the handler returns
 * a non-JSON response (HTML, redirect, etc.), the response is replaced with
 * a 404 JSON envelope. Handlers that support JSON return application/json
 * themselves and pass through unchanged.
 */
export async function call_route_handler(handler: unknown, req: Request, server?: Bun.Server, params: Record<string, string> = {}): Promise<Response> {
	if (params && Object.keys(params).length > 0) { (req as any).params = params; }

	let response: Response;

	if (typeof handler === "function") {
		response = await (handler as (req: Request, server?: Bun.Server) => Response | Promise<Response>)(req, server);
	} else if (handler && typeof handler === "object") {
		const method_handler = (handler as Record<string, unknown>)[req.method];
		if (typeof method_handler === "function") {
			response = await (method_handler as (req: Request, server?: Bun.Server) => Response | Promise<Response>)(req, server);
		} else {
			response = new Response("Method Not Allowed", { status: 405 });
		}
	} else {
		response = new Response("Not Found", { status: 404 });
	}

	// If the client requested JSON but the handler returned HTML/redirect,
	// respond with 404 JSON so machine clients don't receive HTML.
	if (req.headers.get("Accept") === "application/json") {
		const ct = response.headers.get("Content-Type") || "";
		if (!ct.includes("application/json")) {
			return Response.json({ error: "not found" }, { status: 404 });
		}
	}

	return response;
}

// ---------------------------------------------------------------------------
// Fallback request pipeline (S3 -> local storage -> static files -> 404)
// ---------------------------------------------------------------------------

export type FallbackOptions = { is_dev: boolean; static_dir: string; };

/**
 * Shared fallback handler - handles requests that aren't matched by routing.
 * Used by both dev and prod fetch handlers to avoid duplication.
 *
 * Pipeline order:
 * 1. S3 proxy (registered mounts)
 * 2. Local storage fallback for S3-mounted paths
 * 3. Static file serving from static_dir
 * 4. 404 fallback with locale support
 */
export async function handle_fallback_requests(url: URL, req: Request, opts: FallbackOptions): Promise<Response> {
	const { is_dev, static_dir } = opts;

	// S3 proxy - match registered mounts (avatars, uploads, etc.)
	const s3_response = await handle_s3_request(url);
	if (s3_response) return s3_response;

	// Local storage fallback for S3-mounted paths when S3 is not configured.
	const local_storage_dir = get_local_storage_dir();
	if (local_storage_dir) {
		for (const mount of get_s3_mounts()) {
			if (!url.pathname.startsWith(mount.url_prefix)) continue;

			const filename = decodeURIComponent(url.pathname.slice(mount.url_prefix.length));
			if (!filename || filename.includes("..") || filename.includes("\\\\")) continue;

			const key_prefix = mount.key_prefix ?? mount.url_prefix.replace(
				/^\//,
				""
			);
			const local_prefix = key_prefix || mount.bucket;
			const local_file = join(local_storage_dir, local_prefix, filename);
			try {
				if (await Bun.file(local_file).exists()) {
					const cache = mount.immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600";
					return new Response(Bun.file(local_file), {
						status: 200,
						headers: { "Cache-Control": cache },
					});
				}
			} catch {
				/* keep trying other mounts */
			}
			// Matched a mount prefix but file not found - stop here
			break;
		}
	}

	// Handle static files - only reached for paths NOT matching S3 mounts
	const static_headers = is_dev ? { "Cache-Control": "no-store" } : { "Cache-Control": "public, max-age=31536000, immutable" };

	try {
		const file_path = join(static_dir, url.pathname);
		const file = await Bun.file(file_path).exists();
		if (file && file_path.startsWith(static_dir)) {
			return new Response(Bun.file(file_path), { status: 200, headers: static_headers });
		}
	} catch (e) {
		// Continue to route handling if file not found
		console.log("Error rendering static file:", e);
	}

	if (req.headers.get("Accept") === "application/json") {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	// Fallback 404 with full locale support
	const ctx = await create_ctx(req);

	// Load root-level translations for the detected language.
	const lang_translations = translations.get(ctx.lang) ?? {};
	const route_translations = lang_translations.routes ?? {};

	return render("notfound", {
		data: { title: "404 Not Found", ...route_translations },
		status: 404,
		ctx,
	});
}

// ---------------------------------------------------------------------------
// Storage configuration check
// ---------------------------------------------------------------------------

/**
 * Log the active storage configuration (S3 or local filesystem).
 * Exits the process with an error if neither is configured and storage
 * mode is auto-detect (no explicit STORAGE env var).
 */
export function check_storage_config(): void {
	const storage_mode = get_storage_mode();

	if (storage_mode === "s3") {
		if (is_s3_configured()) { console.log("☁️  Storage: S3"); }
	} else if (storage_mode === "local") {
		const local_storage = get_local_storage_dir();
		console.log(`📁 Local storage: ${local_storage}`);
	} else {
		if (!is_s3_configured() && !Bun.env.LOCAL_STORAGE_DIR) {
			console.error("✗ Neither S3 nor LOCAL_STORAGE_DIR is configured. No media storage available.");
			console.error("  Set S3_* env vars for S3, or LOCAL_STORAGE_DIR for local filesystem storage.");
			console.error("  Alternatively, set STORAGE=local or STORAGE=s3 to explicitly pick a backend.");
			process.exit(1);
		}

		if (!is_s3_configured() && Bun.env.LOCAL_STORAGE_DIR) {
			const local_storage = get_local_storage_dir();
			console.log(`📁 Local storage: ${local_storage}`);
		}
	}
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

/**
 * Check for and kill an orphaned server process from a previous run using
 * the stored PID file. Cleans up the PID file content after killing.
 *
 * Safety: verifies the PID belongs to a Bun process before sending SIGKILL
 * to avoid killing an unrelated process that recycled the PID.
 */
export async function kill_previous_pid(pid_file: string | null): Promise<void> {
	if (!pid_file) return;

	const file = Bun.file(pid_file);
	if (!(await file.exists())) return;

	const pid_str = await file.text();
	const pid = Number(pid_str);
	if (!Number.isFinite(pid) || pid <= 0) return;

	// Safety: verify the PID still belongs to a Bun process.
	// PIDs get recycled - a new process may have taken the same PID.
	if (!is_bun_process(pid)) {
		// Stale PID file from an old process - clean up.
		try {
			await Bun.write(pid_file, "");
		} catch {}
		return;
	}

	try {
		process.kill(pid, "SIGKILL");
		console.log(`  💀 Killed orphaned server PID ${pid}`);
	} catch {
		// Process already dead - clean up stale PID file
	}

	try {
		await Bun.write(pid_file, "");
	} catch {}
}

/**
 * Check if a given PID belongs to a running Bun process.
 * Uses `kill(pid, 0)` for existence + platform-specific command inspection.
 */
function is_bun_process(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}

	// On macOS/Linux, read the process name from /proc or ps.
	// Bun processes have "bun" in their command line.
	try {
		const output = Bun.spawnSync({
			cmd: ["ps", "-p", String(pid), "-o", "comm="],
			stdout: "pipe",
			stderr: "pipe",
		});
		const comm = new TextDecoder().decode(output.stdout).trim();
		return comm.includes("bun");
	} catch {
		// Can't verify - safer to leave the PID alone.
		return false;
	}
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export type ServerStartOptions = {
	is_dev: boolean;
	is_agent: boolean;
	is_test: boolean;
	routed: RouteTable;
	create_dev_fetch_handler: () => (req: Request, server: Bun.Server) => Promise<Response>;
	create_prod_fetch_handler: () => (req: Request, server: Bun.Server) => Promise<Response>;
	websocket_config: Bun.WebSocketHandler;
};

/**
 * Start the HTTP server with optional retry logic (5 attempts with 500ms delay).
 *
 * Dev mode: uses a fetch() handler with a mutable global route table
 * (instant hot reload via --hot, no restart).
 *
 * Prod mode: uses Bun's native Radix tree via `routes:` option with
 * a minimal fetch() fallback for S3, static files, and 404.
 */
export async function start_server(opts: ServerStartOptions): Promise<Bun.Server> {
	const { is_dev, is_agent, is_test, routed, create_dev_fetch_handler, create_prod_fetch_handler, websocket_config } = opts;

	const port = is_agent && Bun.env.AGENT_SERVER_PORT ? Number(Bun.env.AGENT_SERVER_PORT) : is_test ? Number(Bun.env.TEST_PORT) || 2600 : Bun.env.PORT || 2338;

	console.log(`🔌 Releasing port ${port}...`);
	await kill_port(port);
	console.log(`🔌 Port ${port} ready`);

	try {
		const hostname = is_agent || is_test ? "127.0.0.1" : "0.0.0.0";

		if (is_dev) {
			return Bun.serve({
				hostname,
				port,
				idleTimeout: 60,
				fetch: create_dev_fetch_handler(),
				websocket: websocket_config,
				development: true,
			});
		} else {
			return Bun.serve({
				hostname,
				port,
				idleTimeout: 60,
				routes: routed,
				fetch: create_prod_fetch_handler(),
				websocket: websocket_config,
			});
		}
	} catch (err) {
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Network address logging
// ---------------------------------------------------------------------------

/**
 * Log the server URL and all available non-internal IPv4 addresses
 * for local network access.
 */
export function log_server_addresses(server: Bun.Server, is_agent: boolean, is_dev: boolean, is_test: boolean): void {
	console.log("---------------------------");
	const env_label = is_test ? "test" : is_dev ? "development" : "production";
	console.log(`🌍 Environment: ${env_label}${is_agent ? " (agent mode)" : ""}`);
	console.log("---------------------------");

	if (is_test) {
		console.log(`🧪 Test server ready at http://127.0.0.1:${server.port}`);
	} else {
		console.log(`🚀 Server running at`);
		console.log("");

		const protocol = parseInt(Bun.env.PORT || "2338", 10) === 8443 ? "https" : "http";

		const display_host = is_agent ? "localhost" : Bun.env.SERVER_NAME;
		const server_url = `${protocol}://${display_host}:${server.port}/`;
		console.log(`\x1b[38;5;2m${server_url.slice(0, -1)}\x1b[0m`);
		console.log("");
		if (!is_agent) {
			console.log("Other available IP addresses:");
			console.log("");
			const nets = os.networkInterfaces();
			for (const name of Object.keys(nets)) {
				for (const net of nets[name]) {
					if (net.family === "IPv4" && !net.internal) { console.log(`${protocol}://${net.address}:${server.port}`); }
				}
			}
		}
		listen_for_open_key(server_url);
	}
}
