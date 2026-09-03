/**
 * Server - entry point for the reepolee HTTP server.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────────┐
 *   │  bun --hot apps/main/server.ts --dev (dev)       │
 *   │  bun apps/main/server.ts --prod      (prod)      │
 *   ├──────────────────────────────────────────────────┤
 *   │  Dev:  fetch() handler + global route table      │
 *   │        (--hot re-evaluates, no restart)          │
 *   │  Prod: Bun.serve({ routes }) Radix tree          │
 *   │        + minimal fetch() fallback                │
 *   │  Watcher: .ree/.css/.json changes → notify       │
 *   └──────────────────────────────────────────────────┘
 *
 * Two routing paths:
 *   Dev  - All routing goes through a fetch handler that reads from a
 *          global mutable route table (lib/route_table.ts). When --hot
 *          re-evaluates modules, the route table is rebuilt in-place.
 *          The server process never restarts.
 *   Prod - Bun's native `routes:` option handles URL matching via an
 *          optimized Radix tree. The fetch handler only runs as fallback
 *          for S3 proxy, static files, and 404. No hot reload needed
 *          (production uses process restart).
 */

import { join } from "node:path";
import type { BunRequest } from "bun";

import { bootstrap } from "$lib/bootstrap";
import { env_available } from "$config/env_vars";
import { canonical_locale } from "$lib/locale";
import { clients, handle_dev_client_request, is_same_origin_upgrade, notify_clients } from "$lib/livereload";
import type { WebSocketData } from "$lib/livereload";
import { resolve_session } from "$platform/auth/middleware";
import { log_error } from "$lib/logger";
import { initialize_render } from "$lib/render";
import { handle_create_issue, handle_issue_repos } from "$lib/issue_reporter";
import { handle_inspector_message } from "$lib/inspector_ws";
import { handle_open_request } from "$lib/open_in_editor";
import { handle_generic_upload_endpoints } from "$lib/upload_endpoints";
import { detect_locale, resolve_canonical_match } from "$lib/route_map";
import { rebuild_routes_and_state, set_route_reloader } from "$lib/route_state";
import { get_base_data, get_route_table, is_first_run, match_route, set_base_data } from "$lib/route_table";
import { handle_s3_request } from "$lib/s3";
import { call_route_handler, handle_fallback_requests, handle_internal_endpoints } from "$lib/server_helpers";
import { discover_static_dirs } from "$lib/static_discovery";
import { create_template_engine } from "$lib/template";
import { default_locale } from "$config/supported_locales";
import "$lib/temporal";
import { now_iso_str } from "$lib/temporal";
import { nav_routes, routes } from "$main/routes";
import { MAIN_APP } from "$config/paths";

// Global error handlers
process.on("unhandledRejection", (reason, promise) => log_error("server", "UNHANDLED PROMISE REJECTION", reason instanceof Error ? reason : new Error(String(reason)), {
	promise: String(promise),
}));

process.on("uncaughtException", (err, origin) => log_error("server", "UNCAUGHT EXCEPTION", err, { origin }));

Bun.env.TZ = Bun.env.TIME_ZONE;

const app_started = now_iso_str();
console.log("App started at ", app_started);

// Servers resolve their own paths from import.meta.dir, never process.cwd().
const project_root = join(import.meta.dir, "..", "..");
const static_dirs = discover_static_dirs(project_root, MAIN_APP);
// is_dev is the single source of truth for the mode (--dev passed = dev).
const is_dev = Bun.argv.includes("--dev");
const is_agent = Bun.argv.includes("--agent");

// --dev and --prod are mutually exclusive - fail loudly instead of silently
// picking a mode (the app must never serve dev mode in production).
if (is_dev && Bun.argv.includes("--prod")) {
	console.error("✗ --dev and --prod cannot be passed together. Use `bun run dev` (development) or `bun run start` (production).");
	process.exit(1);
}
const is_test = Bun.argv.includes("--test");

// Safety: --agent is only allowed in development mode
if (is_agent && !is_dev) {
	console.error("✗ --agent flag is only allowed with --dev (development mode)");
	process.exit(1);
}

// Safety: agent mode must run on its own dedicated port - no silent fallback
// to PORT / 2338, which is reserved for the developer's server.
if (is_agent && !env_available("AGENT_SERVER_PORT")) {
	console.error("✗ --agent requires AGENT_SERVER_PORT to be set in .env (e.g. AGENT_SERVER_PORT=2500)");
	process.exit(1);
}

// Agent mode: use AGENT_SERVER_PORT env var instead of PORT
if (is_agent && Bun.env.AGENT_SERVER_PORT) { console.log(`🤖 Agent mode port: ${Bun.env.AGENT_SERVER_PORT} (localhost only)`); }

if (is_test && Bun.env.TEST_PORT) { console.log(`🧪 Test mode port: ${Bun.env.TEST_PORT} (localhost only)`); }

const fallback_opts = { is_dev, static_dirs };

// WebSocket close codes (3000-4999 are application codes). A plain 401/403 on
// an upgrade surfaces to the client as close code 1006 - identical to a server
// that never answered - so the /__updates rejection completes the handshake
// and closes with one of these codes instead. The client (updates-client.js)
// stops its 1s retry loop on them (adversarial review 2026-08-25).
const WS_REJECT_UNAUTHORIZED = 4401; // no authenticated session
const WS_REJECT_FORBIDDEN = 4403; // cross-origin handshake

/**
 * Reject a /__updates upgrade in a way the client can distinguish from a dead
 * server: complete the handshake and close immediately with the application
 * code. Falls back to a plain HTTP response if the upgrade itself fails.
 */
function reject_upgrade(req: Request, server: Bun.Server<WebSocketData>, code: number, reason: string): Response {
	if (server.upgrade(req, { data: { type: "updates", user_id: null, reject_code: code } })) {
		return new Response(); // handshake completes; open() closes with `code`
	}
	return new Response(reason, { status: code === WS_REJECT_UNAUTHORIZED ? 401 : 403 });
}

// WebSocket config
const websocket_config = {
	open(ws: any) {
		// Rejected upgrades (anonymous / cross-origin) complete the handshake
		// only so the client can read the close code - never admit them to the
		// pool that notify_clients / notify_updates broadcast to.
		if (ws.data?.reject_code) { ws.close(ws.data.reject_code); return; }
		clients.add(ws);
	},
	message(ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer) {
		// Dev-only inspector messages (i18n/class get/update). Only livereload
		// sockets carry a locale and only they speak the inspector protocol -
		// "updates" channel sockets never send messages.
		if (ws.data.type === "livereload") {
			void handle_inspector_message(ws, String(message), process.cwd(), ws.data.locale);
		}
	},
	close(ws: any) { clients.delete(ws); },
};

/**
 * Dev fetch handler - reads routes from the global mutable route table.
 * Used in dev mode where --hot re-evaluation can rebuild routes in-place
 * without restarting the server.
 */
function create_dev_fetch_handler() {
	return async function fetch (req: Request, server: Bun.Server<WebSocketData>): Promise<Response> {
		const url = new URL(req.url);

		// Handle live reload WebSocket upgrade (only in dev). The connection's
		// locale is captured once here (from the `locale` cookie, same
		// resolution as lib/route.ts's resolve_locale) so inspector i18n
		// messages on this socket resolve translations for the page's own locale.
		if (url.pathname === "/__reload") {
			if (!is_same_origin_upgrade(req)) { return new Response("Forbidden", { status: 403 }); }
			const cookie_header = req.headers.get("Cookie") ?? "";
			const raw_locale = cookie_header.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
			const locale = canonical_locale(raw_locale ? decodeURIComponent(raw_locale) : null) ?? default_locale;
			if (server.upgrade(req, { data: { type: "livereload", locale } })) { return new Response(); }
		}

		// CRUD "updates" WebSocket channel (dev and prod): index/forms pages
		// listen here for record mutations so they can surface an "updated"
		// marker with a reload link (issue #336). Same upgrade path in the prod
		// handler - the channel is a production feature, not a dev tool.
		// The payload carries routes, record ids and the mutating user's display
		// name, so the handshake requires a logged-in session and the same origin
		// (adversarial review 2026-08-25). Rejections use upgrade-then-close so
		// the client can stop retrying instead of hammering every second.
		if (url.pathname === "/__updates") {
			if (!is_same_origin_upgrade(req)) return reject_upgrade(req, server, WS_REJECT_FORBIDDEN, "Forbidden");
			const auth = await resolve_session(req as BunRequest);
			if (!auth.session) return reject_upgrade(req, server, WS_REJECT_UNAUTHORIZED, "Unauthorized");
			if (server.upgrade(req, { data: { type: "updates", user_id: auth.current_user?.id ?? null } })) { return new Response(); }
		}

		// Dev-only GitHub issue reporter (Ctrl+Shift+I overlay)
		if (req.method === "POST" && url.pathname === "/__issue") { return handle_create_issue(req); }
		if (req.method === "GET" && url.pathname === "/__issue_repos") { return handle_issue_repos(req); }

		// Dev client scripts (livereload/inspector/issue reporter) as external files
		if (req.method === "GET") {
			const dev_client = await handle_dev_client_request(url);
			if (dev_client) return dev_client;
		}

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
			const localized_match = resolve_canonical_match(url.pathname, locale);
			if (localized_match) {
				const localized_handler = route_table[localized_match.canonical];
				if (localized_handler) { return call_route_handler(localized_handler, req, server, localized_match.params); }
			}
		}

		// Shared fallback: S3/local/static/404 - identical to prod handler
		return handle_fallback_requests(url, req, fallback_opts);
	};
}

/**
 * Production fetch handler - primary routing is handled by Bun's native
 * `routes:` option (Radix tree). This handler only runs as a fallback for:
 * - Admin endpoints
 * - Trailing-slash redirects
 * - S3 proxy / local storage / static files / 404
 */
function create_prod_fetch_handler() {
	return async function fetch (req: Request, server: Bun.Server<WebSocketData>): Promise<Response> {
		const url = new URL(req.url);

		// CRUD "updates" WebSocket channel - same upgrade as the dev handler.
		// This is the production path: Bun's native `routes:` never sees
		// /__updates (not a registered route), so it reaches this fallback.
		if (url.pathname === "/__updates") {
			if (!is_same_origin_upgrade(req)) return reject_upgrade(req, server, WS_REJECT_FORBIDDEN, "Forbidden");
			const auth = await resolve_session(req as BunRequest);
			if (!auth.session) return reject_upgrade(req, server, WS_REJECT_UNAUTHORIZED, "Unauthorized");
			if (server.upgrade(req, { data: { type: "updates", user_id: auth.current_user?.id ?? null } })) { return new Response(); }
		}

		// Internal admin endpoints
		const internal = handle_internal_endpoints(req, url);
		if (internal) return internal;

		// Bun's `routes:` handles all registered routes first - if we reach
		// here, no canonical or localized route matched. Since the route table
		// doesn't duplicate entries with trailing slashes, redirect /path/ -> /path
		// so Bun can match it on the next request.
		if (url.pathname !== "/" && url.pathname.endsWith("/")) {
			return new Response(null, {
				status: 301,
				headers: { Location: url.pathname.slice(0, -1) + (url.search || "") },
			});
		}

		// Shared fallback: S3/local/static/404 - identical to dev handler
		return handle_fallback_requests(url, req, fallback_opts);
	};
}

// Decouple server identity from module re-evaluation
declare global {
	var __reepolee_server: Bun.Server<WebSocketData> | undefined;
}

async function reload_main_routes(): Promise<void> {
	const routes_url = new URL("./routes.ts", import.meta.url);
	routes_url.searchParams.set("reload", String(Date.now()));
	const routes_module = await import(routes_url.href) as typeof import("./routes");
	const { nav_routes: reloaded_nav_routes, routes: reloaded_routes } = routes_module;
	const { nav_groups, routed } = await rebuild_routes_and_state(reloaded_nav_routes, reloaded_routes, is_agent, { hot: true });

	const existing_base = get_base_data();
	set_base_data({ ...existing_base, nav_groups });

	const engine = create_template_engine(is_dev);
	initialize_render(engine, get_base_data());

	if (!is_dev) {
		const server = globalThis.__reepolee_server;
		if (!server) throw new Error("Main server is not initialized.");
		server.reload({ routes: routed, fetch: create_prod_fetch_handler(), websocket: websocket_config });
	}

	if (is_dev && !is_test) { notify_clients(); }
	console.log(`  ✅ ${Object.keys(routed).length} routes updated`);
}

set_route_reloader(reload_main_routes);

// Check: first run or --hot re-evaluation?
// globalThis.__reepolee_route_state persists across --hot re-evaluations.
// If it exists, the server is already running - skip server creation.

const hot_reload = !is_first_run();

if (!hot_reload) {
	try {
		await bootstrap({
			is_dev,
			app_name: "main",
			is_agent,
			is_test,
			nav_routes,
			routes,
			create_dev_fetch_handler,
			create_prod_fetch_handler,
			websocket_config,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("\n----------------------------------------------");
		console.error("  ✗ SERVER BOOTSTRAP FAILED");
		console.error("");
		console.error("  " + msg);
		console.error("");
		console.error("  Server is stopped. Fix the issue and save a file to retry.");
		console.error("----------------------------------------------\n");
		// Do NOT exit - let the process keep running so bun --hot doesn't restart in a loop.
		// The developer will fix the issue and trigger a hot reload by saving a file.
		process.stdin.resume();
	}
} else {
	//
	// HOT RELOAD - rebuild routes/translations in-place, no restart. Load the
	// route registry from disk instead of the static module binding: after
	// Reeman adds an import, Bun can re-evaluate this entry before refreshing
	// that binding, which would otherwise overwrite the generator's fresh
	// route reload with the old table.
	//

	console.log("🔄 Hot reload - rebuilding routes in-place");
	await reload_main_routes();
}

export { sql_log } from "$lib/logger";
