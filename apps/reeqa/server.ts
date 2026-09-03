/**
 * ReeQA app server.
 *
 * Runs the QA dashboard on its own process and port while sharing Reepolee's
 * renderer, auth, route pipeline, translations, components, and static files.
 * QA commands remain isolated child processes and cannot block the main app.
 */

import { join } from "node:path";
import { default_locale } from "$config/supported_locales";
import { env_available } from "$config/env_vars";
import { bootstrap } from "$lib/bootstrap";
import { handle_inspector_message } from "$lib/inspector_ws";
import { handle_create_issue, handle_issue_repos } from "$lib/issue_reporter";
import { canonical_locale } from "$lib/locale";
import { clients, handle_dev_client_request, is_same_origin_upgrade, notify_clients, notify_evidence_ready, notify_recording_ready } from "$lib/livereload";
import type { WebSocketData } from "$lib/livereload";
import { log_error } from "$lib/logger";
import { handle_open_request } from "$lib/open_in_editor";
import { initialize_render } from "$lib/render";
import { detect_locale, resolve_canonical } from "$lib/route_map";
import { rebuild_routes_and_state } from "$lib/route_state";
import { get_base_data, get_route_table, is_first_run, match_route, set_base_data } from "$lib/route_table";
import { handle_s3_request } from "$lib/s3";
import { call_route_handler, handle_fallback_requests, handle_internal_endpoints } from "$lib/server_helpers";
import { discover_static_dirs } from "$lib/static_discovery";
import { create_template_engine } from "$lib/template";
import "$lib/temporal";
import { now_iso_str } from "$lib/temporal";
import { handle_generic_upload_endpoints } from "$lib/upload_endpoints";
import { nav_routes, routes } from "$reeqa/routes";
import { REEQA_APP } from "$config/paths";

process.on("unhandledRejection", (reason, promise) => {
	const error = reason instanceof Error ? reason : new Error(String(reason));
	log_error("server", "UNHANDLED PROMISE REJECTION", error, { promise: String(promise) });
});

process.on("uncaughtException", (error, origin) => {
	log_error("server", "UNCAUGHT EXCEPTION", error, { origin });
});

Bun.env.TZ = Bun.env.TIME_ZONE;

const app_started = now_iso_str();
console.log("ReeQA app started at", app_started);

// Servers resolve their own paths from import.meta.dir, never process.cwd().
const project_root = join(import.meta.dir, "..", "..");
const static_dirs = discover_static_dirs(project_root, REEQA_APP);
const is_dev = Bun.argv.includes("--dev");
const is_agent = Bun.argv.includes("--agent");
const is_prod = Bun.argv.includes("--prod");

function require_reeqa_port(): number {
	const raw_port = Bun.env.REEQA_PORT?.trim();
	const port = Number(raw_port);
	if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
	console.error("REEQA_PORT must be set to a valid TCP port.");
	process.exit(1);
}

if (is_dev && is_prod) {
	console.error("ReeQA cannot start with both --dev and --prod.");
	process.exit(1);
}

if (is_agent && !is_dev) {
	console.error("ReeQA --agent mode requires --dev.");
	process.exit(1);
}

if (is_agent && !env_available("AGENT_REEQA_SERVER_PORT")) {
	console.error("ReeQA --agent mode requires AGENT_REEQA_SERVER_PORT.");
	process.exit(1);
}

const reeqa_port = require_reeqa_port();
const server_port = is_agent ? Number(Bun.env.AGENT_REEQA_SERVER_PORT) : reeqa_port;
const reeqa_pid_file = ".reepolee/server-reeqa.pid";
const fallback_opts = { is_dev, static_dirs };

if (is_agent) {
	console.log(`ReeQA agent mode port: ${server_port}`);
}

const websocket_config = {
	open(ws: Bun.ServerWebSocket<WebSocketData>) {
		clients.add(ws);
	},
	message(ws: Bun.ServerWebSocket<WebSocketData>, message: string | Buffer) {
		// Only livereload sockets speak the inspector protocol ("updates"
		// channel sockets never send messages).
		if (ws.data.type === "livereload") {
			void handle_inspector_message(ws, String(message), process.cwd(), ws.data.locale);
		}
	},
	close(ws: Bun.ServerWebSocket<WebSocketData>) {
		clients.delete(ws);
	},
};

function create_dev_fetch_handler() {
	return async function fetch(req: Request, server: Bun.Server<WebSocketData>): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === "/__reload") {
			if (!is_same_origin_upgrade(req)) { return new Response("Forbidden", { status: 403 }); }
			const cookie_header = req.headers.get("Cookie") ?? "";
			const locale_match = cookie_header.match(/(?:^|;\s*)locale=([^;]+)/);
			const raw_locale = locale_match?.[1];
			const decoded_locale = raw_locale ? decodeURIComponent(raw_locale) : null;
			const locale = canonical_locale(decoded_locale) ?? default_locale;
			const upgraded = server.upgrade(req, { data: { type: "livereload", locale } });
			if (upgraded) return new Response();
		}

		if (req.method === "POST" && url.pathname === "/__issue") {
			return handle_create_issue(req);
		}
		if (req.method === "GET" && url.pathname === "/__issue_repos") {
			return handle_issue_repos(req);
		}

		// Dev client scripts (livereload/inspector/issue reporter) as external files
		if (req.method === "GET") {
			const dev_client = await handle_dev_client_request(url);
			if (dev_client) return dev_client;
		}

		// The evidence job runs in the queue worker (a separate process), so it
		// can't reach this server's WebSocket clients directly. The worker POSTs
		// here when a video finishes; this broadcasts a targeted message that the
		// report page's client listens for.
		if (req.method === "POST" && url.pathname === "/__reeqa_evidence_ready") {
			const body = await req.text().catch(() => "");
			const params = new URLSearchParams(body);
			const run_id = params.get("run_id") ?? "";
			const page_id = params.get("page_id") ?? "";
			if (run_id && page_id) notify_evidence_ready(run_id, page_id, params.get("video_path") ?? undefined, params.get("error") ?? undefined);
			return new Response("OK");
		}

		// Recording job runs in the queue worker too - same relay pattern as
		// /__reeqa_evidence_ready, for the mode-3 recording clip.
		if (req.method === "POST" && url.pathname === "/__reeqa_recording_ready") {
			const body = await req.text().catch(() => "");
			const params = new URLSearchParams(body);
			const run_id = params.get("run_id") ?? "";
			const page_id = params.get("page_id") ?? "";
			if (run_id && page_id) notify_recording_ready(run_id, page_id, params.get("recording_path") ?? undefined, params.get("error") ?? undefined);
			return new Response("OK");
		}

		if (req.method === "POST" && url.pathname === "/__ree_open") {
			return handle_open_request(process.cwd(), url);
		}

		const generic_upload = await handle_generic_upload_endpoints(req, url);
		if (generic_upload) return generic_upload;

		const internal = handle_internal_endpoints(req, url);
		if (internal) return internal;

		const route_table = get_route_table();
		const route_match = match_route(url.pathname, route_table);
		if (route_match) {
			return call_route_handler(route_match.handler, req, server, route_match.params);
		}

		const s3_response = await handle_s3_request(url, req);
		if (s3_response) return s3_response;

		const locale = detect_locale(url.pathname);
		if (locale) {
			const canonical = resolve_canonical(url.pathname, locale);
			if (canonical) {
				const localized_handler = route_table[canonical];
				if (localized_handler) return call_route_handler(localized_handler, req, server);
			}
		}

		return handle_fallback_requests(url, req, fallback_opts);
	};
}

function create_prod_fetch_handler() {
	return async function fetch(req: Request, _server: Bun.Server<WebSocketData>): Promise<Response> {
		const url = new URL(req.url);
		const internal = handle_internal_endpoints(req, url);
		if (internal) return internal;

		if (url.pathname !== "/" && url.pathname.endsWith("/")) {
			const location = url.pathname.slice(0, -1) + (url.search || "");
			return new Response(null, { status: 301, headers: { Location: location } });
		}

		return handle_fallback_requests(url, req, fallback_opts);
	};
}

declare global {
	var __reepolee_server: Bun.Server<WebSocketData> | undefined;
}

const hot_reload = !is_first_run();

if (!hot_reload) {
	try {
		await bootstrap({
			is_dev,
			app_name: "reeqa",
			is_agent,
			is_test: false,
			nav_routes,
			routes,
			create_dev_fetch_handler,
			create_prod_fetch_handler,
			websocket_config,
			port: server_port,
			pid_file: reeqa_pid_file,
			// This app serves /__busy (apps/reeqa/dashboard) - the shared
			// layout's busy-poller may render here.
			busy_poller: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error("\nReeQA server bootstrap failed.");
		console.error(message);
		console.error("The server is stopped. Fix the issue and save a file to retry.\n");
		process.stdin.resume();
	}
} else {
	console.log("Rebuilding ReeQA routes in place");
	const rebuilt = await rebuild_routes_and_state(nav_routes, routes, is_agent, { hot: true });
	const existing_base = get_base_data();
	set_base_data({ ...existing_base, nav_groups: rebuilt.nav_groups, busy_poller: true });

	const engine = create_template_engine(is_dev);
	initialize_render(engine, get_base_data());

	if (is_dev) notify_clients();
	console.log(`${Object.keys(rebuilt.routed).length} ReeQA routes updated`);
}

export { sql_log } from "$lib/logger";
