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

import { dev_app_links, type Dev_app_name } from "$config/apps";
import { verify_db_schema } from "$config/db";
import { check_env_vars, N_A, redis_available } from "$config/env_vars";
import { translations } from "$lib/i18n";
import { notify_clients } from "$lib/livereload";
import type { WebSocketData } from "$lib/livereload";
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
import { precompile_templates } from "$lib/template/precompile";
import "$lib/temporal";
import { now_epoch_ms } from "$lib/temporal";
import { assert_csrf_secret } from "$lib/middleware/csrf";
import { is_redis_backed } from "$lib/middleware/rate_limit_store";
import rate_limit_store_sql from "$lib/middleware/rate_limit_store_sql";
import { start_watcher } from "$lib/watcher";
import { cleanup_expired_jobs, init_queue, is_queue_redis_backed } from "$queue/index";
import { cleanup_expired } from "$platform/auth/session_store";

// ---------------------------------------------------------------------------
// Bootstrap options
// ---------------------------------------------------------------------------

export type BootstrapOptions = {
	is_dev: boolean;
	is_agent: boolean;
	is_test: boolean;
	nav_routes: NavRoute[];
	routes: RouteTable;
	create_dev_fetch_handler: () => (req: Request, server: Bun.Server<WebSocketData>) => Promise<Response>;
	create_prod_fetch_handler: () => (req: Request, server: Bun.Server<WebSocketData>) => Promise<Response>;
	websocket_config: Bun.WebSocketHandler<WebSocketData>;
	// Explicit port + PID file overrides for a second app process (the reeman
	// app, apps/reeman/server.ts) sharing this checkout. Default to the main app's
	// PORT-derived values when omitted, so existing callers are unchanged.
	port?: number;
	/** Development app identity used by the shared app switcher. */
	app_name: Dev_app_name;
	pid_file?: string | null;
	// Apps that serve a /__busy status endpoint (reeman, reeqa) opt in so the
	// shared layout renders the busy-poller. The main app serves no such route,
	// so without this flag its pages would poll /__busy every few seconds into
	// a 404 (see components/busy-poller.ree).
	busy_poller?: boolean;
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

	// Resolve the CSRF signing secret before anything can serve a request, so a
	// production deploy missing CSRF_SECRET fails at boot rather than 403ing
	// every form submission. Agent mode does not mount csrf_mw.
	if (!is_agent) { assert_csrf_secret(); }

	// Surface .env drift: every variable in the committed KNOWN_ENV_VARS
	// inventory must be present in the environment. "N/A" is the explicit "not
	// available" marker that keeps a documented-but-unused feature off instead
	// of silently absent. Fails loud so a misconfigured environment never boots
	// half-configured. Skipped under --test to keep the suite independent of the
	// local .env.
	if (!is_test) {
		const env_check = check_env_vars();
		if (env_check.missing.length > 0) {
			console.error(`\x1b[31m✗ .env check: ${env_check.missing.length} variable(s) from KNOWN_ENV_VARS are not set: ${env_check.missing.join(", ")}\x1b[0m`);
			console.error(`\x1b[31m  Set each to a value, or to "${N_A}" to mark it as not available (turns the feature off).\x1b[0m`);
			process.exit(1);
		}
		if (env_check.invalid.length > 0) {
			const detail = env_check.invalid.map((item) => `${item.name}=${item.value} (expected ${item.allowed.join(" | ")})`).join(", ");
			console.error(`\x1b[31m✗ .env check: ${env_check.invalid.length} variable(s) have an invalid value: ${detail}\x1b[0m`);
			process.exit(1);
		}
		if (env_check.inconsistent_groups.length > 0) {
			const detail = env_check.inconsistent_groups
				.map((item) => `${item.group} (${item.switch}=on, but ${item.missing_members.join(", ")} still "${N_A}")`)
				.join("; ");
			console.error(`\x1b[31m✗ .env check: ${env_check.inconsistent_groups.length} group(s) are partially configured: ${detail}\x1b[0m`);
			process.exit(1);
		}

		// SESSION_STORE="redis" is a deliberate choice, not a preference. The
		// Redis session store falls back to SQL when it cannot load
		// (platform/auth/session_store.ts), so without this check a contradictory
		// config boots quietly on SQL sessions with only a stray red log line to
		// say otherwise. Fail here, while the operator is still reading .env.
		const session_store = (Bun.env.SESSION_STORE ?? "sql").trim().toLowerCase();
		if (session_store === "redis" && !redis_available()) {
			console.error(`\x1b[31m✗ .env check: SESSION_STORE="redis" but Redis is not available.\x1b[0m`);
			console.error(`\x1b[31m  Set REDIS_ENABLED=true and REDIS_URL to a real redis:// URL, or set SESSION_STORE="sql".\x1b[0m`);
			process.exit(1);
		}
	}

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

	// Eager template precompilation: in prod, glob routes/, mounted module
	// roots (registered at route-module import time, i.e. before bootstrap),
	// and components/ for *.ree, compile each once, and cache so render()/raw
	// includes hit memory instead of disk per request. In dev it only builds
	// the component/name registry (templates recompile per render for hot
	// reload). A compile failure aborts boot loudly (fail-loud convention).
	const precompile = await precompile_templates(engine);
	if (!is_dev && !is_test) {
		console.log(`⚡ Precompiled ${precompile.total} template(s)`);
	}

	console.log(`${description} ${version}`);

	// Rebuild routes & nav state (shared with hot-reload path).
	// Translates, builds nav groups, route maps, alias expansion,
	// middleware wrapping, and stores all route/state in the global registry.
	const { nav_groups, routed } = await rebuild_routes_and_state(nav_routes, routes, is_agent);

	const base_data = {
		site_name: `reepolee App v${version}`,
		year: Temporal.Now.zonedDateTimeISO().year,
		is_dev,
		app_name: opts.app_name,
		dev_apps: is_dev ? dev_app_links(opts.app_name) : [],
		nav_groups,
		version,
		busy_poller: opts.busy_poller === true,
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

	// PID file - kill orphaned processes before binding. A second app process
	// (reeman app) passes its own pid_file so the two do not fight over one file.
	const PID_FILE = opts.pid_file !== undefined ? opts.pid_file : is_test ? null : is_agent ? ".reepolee/server-agent.pid" : ".reepolee/server.pid";

	// Server lifecycle
	const prev_server = globalThis.__reepolee_server as Bun.Server<WebSocketData> | undefined;
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
		port: opts.port,
	});
	globalThis.__reepolee_server = server;

	// Write PID file so future instances can find and kill orphaned processes on startup
	if (PID_FILE) {
		await Bun.write(PID_FILE, process.pid.toString());

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

	// Queue jobs carry a 24 h expiry; the SQL store sweeps them (Redis expires
	// its own hashes, so its sweep is a no-op and is skipped here). Skipped
	// under --test.
	if (!is_test && !is_queue_redis_backed()) { start_queue_cleanup(); }

	// Log server addresses
	log_server_addresses(server, is_agent, is_dev, is_test);
}

/**
 * Schedule a housekeeping sweep on an in-process cron job.
 *
 * `Bun.cron` (callback overload) computes the next fire time only after the
 * handler settles, so a slow sweep can never stack on itself the way a bare
 * `setInterval` could, and jobs re-register cleanly across `bun --hot` reloads
 * instead of leaking a timer per re-evaluation. `.unref()` keeps the schedule
 * from holding the process open on its own.
 *
 * Cron only fires on wall-clock boundaries, so the caller's warm-up run still
 * happens here immediately at startup.
 */
function schedule_sweep(
	schedule: string,
	label: string,
	noun: string,
	run_sweep: () => Promise<number>,
): void {
	const sweep = async () => {
		try {
			const deleted = await run_sweep();
			if (deleted > 0) { console.log(`[${label}] Cleaned up ${deleted} expired ${noun}(s)`); }
		} catch (err) {
			console.error(`[${label}] cleanup failed:`, err instanceof Error ? err.message : String(err));
		}
	};

	Bun.cron(schedule, sweep).unref();
	void sweep();
}

// Hourly sweep - session TTL is 7 days, so this is ample.
function start_session_cleanup(): void {
	schedule_sweep("@hourly", "session", "session", cleanup_expired);
}

// Rate limit windows are 60s, not 7 days, so counter rows turn over far faster
// than sessions and the sweep cadence is correspondingly shorter.
function start_rate_limit_cleanup(): void {
	schedule_sweep("*/5 * * * *", "rate_limit", "counter", () => rate_limit_store_sql.cleanup_expired());
}

// Queue job TTL is 24 h (matching the Redis hash expiry), so an hourly sweep
// is ample - same cadence as sessions.
function start_queue_cleanup(): void {
	schedule_sweep("@hourly", "queue", "job", cleanup_expired_jobs);
}
