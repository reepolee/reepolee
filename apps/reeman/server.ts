/**
 * Reeman app server - second entry point sharing this checkout with server.ts.
 *
 * Runs the reeman generator UI plus the sysadmin-ish pages (users, translations,
 * global_scopes, modules, rate_limits, cache, queues, images, files, studio)
 * that live under apps/reeman/, on its own REEMAN_PORT (default 2339). It is
 * a separate `bun --hot` process from the main app (server.ts, PORT 2338): its
 * own hot restarts - and reettier reformatting apps/reeman/** - never touch
 * the main app's module graph or the traffic it serves.
 *
 * Auth is shared: login/session/invite come from platform/auth, which sits
 * outside every app tree, so apps/reeman/routes.ts imports auth_crud from the
 * same path the main app does. The two ports are different origins for CORS
 * and storage, but host-only cookies are shared across ports and resolve to
 * the same users row.
 *
 * Same bootstrap/fetch-handler logic as server.ts; only the routes module, the
 * static folder walked, the port, and the PID file differ.
 */

import { join } from "node:path";
import { bootstrap } from "$lib/bootstrap";
import { env_available } from "$config/env_vars";
import { clients, notify_clients } from "$lib/livereload";
import type { WebSocketData } from "$lib/livereload";
import { log_error } from "$lib/logger";
import { initialize_render } from "$lib/render";
import { handle_create_issue } from "$lib/issue_reporter";
import { handle_inspector_message } from "$lib/inspector_ws";
import { handle_open_request } from "$lib/open_in_editor";
import { handle_generic_upload_endpoints } from "$lib/upload_endpoints";
import { canonical_locale } from "$lib/locale";
import { detect_locale, resolve_canonical } from "$lib/route_map";
import { default_locale } from "$config/supported_locales";
import { rebuild_routes_and_state } from "$lib/route_state";
import { get_base_data, get_route_table, is_first_run, match_route, set_base_data } from "$lib/route_table";
import { handle_s3_request } from "$lib/s3";
import { call_route_handler, handle_fallback_requests, handle_internal_endpoints } from "$lib/server_helpers";
import { discover_static_dirs } from "$lib/static_discovery";
import { create_template_engine } from "$lib/template";
import "$lib/temporal";
import { now_iso_str } from "$lib/temporal";
import { nav_routes, routes } from "$reeman/routes";
import { REEMAN_APP } from "$config/paths";

// Global error handlers
process.on("unhandledRejection", (reason, promise) => log_error("server", "UNHANDLED PROMISE REJECTION", reason instanceof Error ? reason : new Error(String(reason)), {
	promise: String(promise),
}));

process.on("uncaughtException", (err, origin) => log_error("server", "UNCAUGHT EXCEPTION", err, { origin }));

Bun.env.TZ = Bun.env.TIME_ZONE;

const app_started = now_iso_str();
console.log("Reeman app started at ", app_started);

// Servers resolve their own paths from import.meta.dir, never process.cwd().
const project_root = join(import.meta.dir, "..", "..");
const static_dirs = discover_static_dirs(project_root, REEMAN_APP);
// is_dev is the single source of truth for the mode (--dev passed = dev).
const is_dev = Bun.argv.includes("--dev");
const is_agent = Bun.argv.includes("--agent");

// --dev and --prod are mutually exclusive - fail loudly instead of silently
// picking a mode (the reeman app must never serve dev mode in production).
if (is_dev && Bun.argv.includes("--prod")) {
	console.error("✗ --dev and --prod cannot be passed together. Use `bun run dev:reeman` (development) or `bun run start:reeman` (production).");
	process.exit(1);
}

// Safety: --agent is only allowed in development mode
if (is_agent && !is_dev) {
	console.error("✗ --agent flag is only allowed with --dev (development mode)");
	process.exit(1);
}

// Safety: agent mode must run on its own dedicated port - no silent fallback
// to REEMAN_PORT / 2339, which is reserved for the developer's server.
if (is_agent && !env_available("AGENT_REEMAN_SERVER_PORT")) {
	console.error("✗ --agent requires AGENT_REEMAN_SERVER_PORT to be set in .env (e.g. AGENT_REEMAN_SERVER_PORT=2501)");
	process.exit(1);
}

// Agent mode: use AGENT_REEMAN_SERVER_PORT env var instead of REEMAN_PORT
if (is_agent && Bun.env.AGENT_REEMAN_SERVER_PORT) { console.log(`🤖 Agent mode port: ${Bun.env.AGENT_REEMAN_SERVER_PORT} (localhost only)`); }

const reeman_port = Number(Bun.env.REEMAN_PORT) || 2339;
const reeman_pid_file = ".reepolee/server-reeman.pid";

const fallback_opts = { is_dev, static_dirs };

// WebSocket config
const websocket_config = {
	open(ws: any) { clients.add(ws); },
	message(ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer) {
		// Dev-only inspector messages (i18n/class get/update) - same dispatch as server.ts.
		// Only livereload sockets speak the inspector protocol ("updates"
		// channel sockets never send messages).
		if (ws.data.type === "livereload") {
			void handle_inspector_message(ws, String(message), process.cwd(), ws.data.locale);
		}
	},
	close(ws: any) { clients.delete(ws); },
};

/**
 * Dev fetch handler - reads routes from the global mutable route table.
 * Identical shape to server.ts's dev handler.
 */
function create_dev_fetch_handler() {
	return async function fetch (req: Request, server: Bun.Server<WebSocketData>): Promise<Response> {
		const url = new URL(req.url);

		// Handle live reload WebSocket upgrade (only in dev). locale is captured
		// once here (from the `locale` cookie, same resolution as
		// lib/route.ts's resolve_locale) so inspector i18n messages on this
		// socket resolve translations for the page's own locale.
		if (url.pathname === "/__reload") {
			const cookie_header = req.headers.get("Cookie") ?? "";
			const raw_locale = cookie_header.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
			const locale = canonical_locale(raw_locale ? decodeURIComponent(raw_locale) : null) ?? default_locale;
			if (server.upgrade(req, { data: { type: "livereload", locale } })) { return new Response(); }
		}

		// Dev-only GitHub issue reporter (Ctrl+Shift+I overlay)
		if (req.method === "POST" && url.pathname === "/__issue") { return handle_create_issue(req); }

		// Dev-only "open in editor" for the inspector (Meta+Shift / Alt+Shift overlay)
		if (req.method === "POST" && url.pathname === "/__ree_open") { return handle_open_request(process.cwd(), url); }

		// Generic table-agnostic upload endpoints (per-field CRUD uploads)
		const generic_upload = await handle_generic_upload_endpoints(req, url);
		if (generic_upload) return generic_upload;

		// Internal admin endpoints
		const internal = handle_internal_endpoints(req, url);
		if (internal) return internal;

		// Route matching from global mutable table
		const route_table = get_route_table();
		const match = match_route(url.pathname, route_table);
		if (match) { return call_route_handler(match.handler, req, server, match.params); }

		// S3 proxy - match registered mounts (avatars, uploads, etc.)
		const s3_response = await handle_s3_request(url, req);
		if (s3_response) return s3_response;

		// Dynamic route resolution for localized paths (route_name translations).
		const locale = detect_locale(url.pathname);
		if (locale) {
			const canonical = resolve_canonical(url.pathname, locale);
			if (canonical) {
				const localized_handler = route_table[canonical];
				if (localized_handler) { return call_route_handler(localized_handler, req, server); }
			}
		}

		// Shared fallback: S3/local/static/404 - identical to prod handler
		return handle_fallback_requests(url, req, fallback_opts);
	};
}

/**
 * Production fetch handler - fallback for admin endpoints, trailing-slash
 * redirects, S3 proxy, static files, and 404. Identical to server.ts's.
 */
function create_prod_fetch_handler() {
	return async function fetch (req: Request, _server: Bun.Server<WebSocketData>): Promise<Response> {
		const url = new URL(req.url);

		const internal = handle_internal_endpoints(req, url);
		if (internal) return internal;

		if (url.pathname !== "/" && url.pathname.endsWith("/")) {
			return new Response(null, {
				status: 301,
				headers: { Location: url.pathname.slice(0, -1) + (url.search || "") },
			});
		}

		return handle_fallback_requests(url, req, fallback_opts);
	};
}

// Decouple server identity from module re-evaluation (see server.ts).
declare global {
	var __reepolee_server: Bun.Server<WebSocketData> | undefined;
}

const hot_reload = !is_first_run();

if (!hot_reload) {
	try {
		await bootstrap({
			is_dev,
			app_name: "reeman",
			is_agent,
			is_test: false,
			nav_routes,
			routes,
			create_dev_fetch_handler,
			create_prod_fetch_handler,
			websocket_config,
			// Agent mode uses AGENT_REEMAN_SERVER_PORT - don't override with reeman_port
			port: is_agent ? Number(Bun.env.AGENT_REEMAN_SERVER_PORT) : reeman_port,
			pid_file: reeman_pid_file,
			// This app serves /__busy (reeman/reeman/index.ts) - the shared
			// layout's busy-poller may render here.
			busy_poller: true,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("\n----------------------------------------------");
		console.error("  ✗ REEMAN SERVER BOOTSTRAP FAILED");
		console.error("");
		console.error("  " + msg);
		console.error("");
		console.error("  Server is stopped. Fix the issue and save a file to retry.");
		console.error("----------------------------------------------\n");
		// Do NOT exit - let bun --hot keep the process so it doesn't restart in a loop.
		process.stdin.resume();
	}
} else {
	//
	// HOT RELOAD - rebuild routes/translations in-place, no restart
	//

	console.log("🔄 Hot reload - rebuilding reeman routes in-place");

	const { nav_groups, routed } = await rebuild_routes_and_state(nav_routes, routes, is_agent, { hot: true });

	const existing_base = get_base_data();
	set_base_data({ ...existing_base, nav_groups, busy_poller: true });

	const engine = create_template_engine(is_dev);
	initialize_render(engine, get_base_data());

	if (is_dev) { notify_clients(); }

	console.log(`  ✅ ${Object.keys(routed).length} reeman routes updated`);
}

export { sql_log } from "$lib/logger";
