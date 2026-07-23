/**
 * Bootstrap - first-run server initialization.
 *
 * The first time the server starts (not a --hot reload), this module
 * orchestrates the full initialization sequence: creating the template
 * engine, loading modules, building routes, starting the HTTP server,
 * managing PID files, and logging server addresses.
 *
 * The function receives values that can't be imported directly:
 * module-level flags (is_dev, is_agent, is_test), route definitions
 * (nav_routes, routes), and handler factories/config defined in server.ts.
 * Everything else is imported directly from their canonical modules.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { verify_db_schema } from "$config/db";
import { emit_translations } from "$lib/emit_translations";
import { translations } from "$lib/i18n";
import { notify_clients } from "$lib/livereload";
import type { RouteTable } from "$lib/middleware/types";
import { load_modules } from "$lib/modules";
import { initialize_render } from "$lib/render";
import type { NavRoute } from "$lib/route_builder";
import { rebuild_routes_and_state } from "$lib/route_state";
import { mark_initialized, set_base_data } from "$lib/route_table";
import { register_s3_mount } from "$lib/s3";
import { check_storage_config, kill_previous_pid, log_server_addresses, start_server } from "$lib/server_helpers";
import { kill_port } from "$lib/port_release";
import { create_template_engine } from "$lib/template";
import "$lib/temporal";
import { now_epoch_ms } from "$lib/temporal";
import { is_redis_backed } from "$lib/middleware/rate_limit_store";
import rate_limit_store_sql from "$lib/middleware/rate_limit_store_sql";
import { start_watcher } from "$lib/watcher";
import { init_queue } from "$queue/index";
import { cleanup_expired } from "$root/routes/system/auth/session_store";

// ---------------------------------------------------------------------------
// Bootstrap options
// ---------------------------------------------------------------------------

export type BootstrapOptions = {
	is_dev: boolean;
	is_agent: boolean;
	is_test: boolean;
	nav_routes: NavRoute[];
	routes: RouteTable;
	create_dev_fetch_handler: () => (req: Request, server: Bun.Server) => Promise<Response>;
	create_prod_fetch_handler: () => (req: Request, server: Bun.Server) => Promise<Response>;
	websocket_config: Bun.WebSocketHandler;
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Full first-run initialization sequence.
 *
 * Called exactly once on cold start (not on --hot reload). Sets up:
 * - Template engine & render
 * - All async services (queue, modules, translations)
 * - Navigation groups, route maps, and localized URL aliases
 * - Middleware chain (rate limiting, language, CSRF)
 * - Route table registration
 * - S3 mount registration
 * - Storage configuration check
 * - PID file management (kill orphaned process, write new PID)
 * - HTTP server start (dev: fetch handler, prod: native routes)
 * - File watcher (dev only)
 * - Server address logging
 */
export async function bootstrap(opts: BootstrapOptions): Promise<void> {
	const { is_dev, is_agent, is_test, nav_routes, routes, create_dev_fetch_handler, create_prod_fetch_handler, websocket_config } = opts;

	mark_initialized();

	const engine = create_template_engine(is_dev);

	const package_path = join(process.cwd(), "package.json");
	const pkg = await Bun.file(package_path).json();

	const description = pkg.description;
	const version = is_dev ? now_epoch_ms().toString().slice(-4) : pkg.version;

	// Database schema check
	// Must run before load_modules() since it queries the modules table
	await verify_db_schema();

	await Promise.all([
		init_queue(),
		load_modules(),
		translations.initialize(),
	]);

	// Dump translation trees to .reepolee/i18n/<lang>.json so the ree-templates
	// extension can show ghost values in .ree files. Dev-only working aid.
	if (is_dev && !is_test) { await emit_translations(translations.all); }

	console.log(`${description} ${version}`);

	// Rebuild routes & nav state (shared with hot-reload path).
	// Translates, builds nav groups, route maps, alias expansion,
	// middleware wrapping, and stores all route/state in the global registry.
	const { nav_groups, routed } = await rebuild_routes_and_state(nav_routes, routes, is_agent);

	const base_data = {
		site_name: `reepolee App v${version}`,
		year: Temporal.Now.zonedDateTimeISO().year,
		is_dev,
		nav_groups,
		version,
	};

	set_base_data(base_data);
	initialize_render(engine, base_data);

	if (is_agent) { console.log("🤖 Agent mode - CSRF disabled, session bypassed. Auth via X-Agent-User-Username header or AGENT_USER_USERNAME env var."); }

	// Register S3 mounts for file serving
	register_s3_mount({ url_prefix: "/avatars/", bucket: "users", immutable: true });
	register_s3_mount({
		url_prefix: `/${Bun.env.S3_IMAGE_BUCKET || "images"}/`,
		bucket: Bun.env.S3_IMAGE_BUCKET || "images",
		key_prefix: "",
		immutable: true,
	});
	register_s3_mount({
		url_prefix: `/${Bun.env.S3_FILE_BUCKET || "files"}/`,
		bucket: Bun.env.S3_FILE_BUCKET || "files",
		key_prefix: "",
		immutable: true,
	});

	// Storage sanity check
	check_storage_config();

	// PID file - kill orphaned processes before binding
	const PID_FILE = is_test ? null : ".reepolee/server.pid";

	// Server lifecycle
	const prev_server = globalThis.__reepolee_server as Bun.Server | undefined;
	if (prev_server) {
		try {
			await prev_server.stop();
			console.log("  Stopped previous server instance");
		} catch {
			// ignore - old server may have already died
		}
	} else {
		await kill_previous_pid(PID_FILE);
	}

	const server = await start_server({
		is_dev,
		is_agent,
		is_test,
		routed,
		create_dev_fetch_handler,
		create_prod_fetch_handler,
		websocket_config,
	});
	globalThis.__reepolee_server = server;

	// Write PID file so future instances can find and kill orphaned processes on startup
	if (PID_FILE) {
		await Bun.write(PID_FILE, (Bun.pid ?? process.pid).toString());

		// Clean up PID file on exit (synchronous - no async in exit handlers)
		process.on("exit", () => {
			try {
				unlinkSync(PID_FILE);
			} catch {
				// file may already be gone
			}
		});
	}

	if (is_dev && !is_test) { start_watcher(notify_clients); }

	// Periodically sweep expired sessions from the SQL stores (Redis expires
	// keys natively, so its cleanup is a no-op). Without this, abandoned
	// sessions - only deleted lazily on access - accumulate forever. Skipped
	// under --test so the suite doesn't spawn a lingering interval.
	if (!is_test) { start_session_cleanup(); }

	// Same rationale for rate limit counters, but they are only swept when SQL
	// backs the limiter - Redis expires its own keys. Skipped under --test.
	if (!is_test && !is_redis_backed()) { start_rate_limit_cleanup(); }

	// Log server addresses
	log_server_addresses(server, is_agent, is_dev, is_test);
}

// One-hour sweep interval - session TTL is 7 days, so this is ample.
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function start_session_cleanup(): void {
	const sweep = async () => {
		try {
			const deleted = await cleanup_expired();
			if (deleted > 0) { console.log(`[session] Cleaned up ${deleted} expired session(s)`); }
		} catch (err) {
			console.error("[session] cleanup failed:", err instanceof Error ? err.message : String(err));
		}
	};

	// Run once shortly after start, then on a fixed interval. unref() so the
	// timer never keeps the process alive on its own.
	const timer = setInterval(sweep, SESSION_CLEANUP_INTERVAL_MS);
	if (typeof (timer as any).unref === "function") { (timer as any).unref(); }
	void sweep();
}

// Rate limit windows are 60s, not 7 days, so counter rows turn over far faster
// than sessions and the sweep interval is correspondingly shorter.
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function start_rate_limit_cleanup(): void {
	const sweep = async () => {
		try {
			const deleted = await rate_limit_store_sql.cleanup_expired();
			if (deleted > 0) { console.log(`[rate_limit] Cleaned up ${deleted} expired counter(s)`); }
		} catch (err) {
			console.error("[rate_limit] cleanup failed:", err instanceof Error ? err.message : String(err));
		}
	};

	const timer = setInterval(sweep, RATE_LIMIT_CLEANUP_INTERVAL_MS);
	if (typeof (timer as any).unref === "function") { (timer as any).unref(); }
	void sweep();
}
