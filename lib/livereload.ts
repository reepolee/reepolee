import { join } from "node:path";

// Data attached at server.upgrade(req, { data: {...} }). Two WebSocket uses
// share one connection pool:
// - "livereload" (dev) - `locale` is captured once at upgrade time (from the
//   `locale` cookie, same resolution as lib/route.ts's resolve_locale) so
//   inspector i18n messages on this connection resolve against the same
//   locale the page was rendered in.
// - "updates" (dev + prod) - CRUD mutation notifications for the "updated
//   records" marker (route/action/id payloads, see notify_updates). The
//   upgrade is rejected for anonymous visitors and `user_id` records which
//   session the socket belongs to (adversarial review 2026-08-25). Rejected
//   upgrades complete the handshake and close immediately with `reject_code`
//   (4401 no session, 4403 cross-origin) so the client can tell an explicit
//   rejection apart from a server that is merely still booting and stop its
//   retry loop (adversarial review 2026-08-25).
export type WebSocketData = { type: "livereload"; locale: string; } | { type: "updates"; user_id: number | null; reject_code?: number };

let _client_script: string | null = null;
let _issue_reporter_script: string | null = null;
let _inspector_script: string | null = null;

// @internal - for testing: pre-set the client script content without reading a file.
export function __set_client_script(content: string): void { _client_script = content; }

// @internal - for testing: pre-set the issue reporter script content without reading a file.
export function __set_issue_reporter_script(content: string): void { _issue_reporter_script = content; }

// @internal - for testing: pre-set the inspector script content without reading a file.
export function __set_inspector_script(content: string): void { _inspector_script = content; }

async function get_client_script(): Promise<string> {
	if (_client_script === null) {
		try {
			_client_script = await Bun.file(join(import.meta.dir, "livereload_client.js")).text();
		} catch {
			_client_script = "";
		}
	}
	return _client_script;
}

async function get_issue_reporter_script(): Promise<string> {
	if (_issue_reporter_script === null) {
		try {
			_issue_reporter_script = await Bun.file(join(import.meta.dir, "issue_reporter_client.js")).text();
		} catch {
			_issue_reporter_script = "";
		}
	}
	return _issue_reporter_script;
}

async function get_inspector_script(): Promise<string> {
	if (_inspector_script === null) {
		try {
			_inspector_script = await Bun.file(join(import.meta.dir, "inspector_client.js")).text();
		} catch {
			_inspector_script = "";
		}
	}
	return _inspector_script;
}

// Stored on globalThis (like $lib/route_table's route state) so the Set
// identity survives `bun --hot` re-evaluation. server.ts imports this module
// directly, so editing any .ts file in the --hot dependency graph
// re-evaluates this module; a plain module-level `const` would be replaced
// with a fresh, empty Set - desyncing it from the WebSocket open/close
// handlers bound once at the original Bun.serve() call, and notify_clients()
// would silently iterate zero connections.
declare global {
	var __reepolee_livereload_clients: Set<Bun.ServerWebSocket<WebSocketData>> | undefined;
}

globalThis.__reepolee_livereload_clients ??= new Set<Bun.ServerWebSocket<WebSocketData>>();
export const clients = globalThis.__reepolee_livereload_clients;

/**
 * Same-origin gate for WebSocket upgrade requests. Browsers always send an
 * Origin header on the handshake, so a cross-site page cannot open a
 * WebSocket to a developer's localhost and speak the socket protocol;
 * non-browser clients send no Origin and pass (they are not CSRF-able).
 * Upgrade handlers in the three app servers share this so the checks cannot
 * drift apart.
 */
export function is_same_origin_upgrade(req: Request): boolean {
	const origin = req.headers.get("Origin");
	if (!origin) return true;
	try {
		return new URL(origin).host === new URL(req.url).host;
	} catch {
		return false;
	}
}

export async function inject_live_reload(html_content: string): Promise<string> {
	const tag = `<script src="${DEV_CLIENT_ROUTES.livereload}" defer></script>`;

	if (html_content.match(/<\/body>/i)) { return html_content.replace(/<\/body>/i, `${tag}</body>`); }

	return html_content + tag;
}

export async function inject_issue_reporter(html_content: string): Promise<string> {
	const tag = `<script src="${DEV_CLIENT_ROUTES.issue_reporter}" defer></script>`;

	if (html_content.match(/<\/body>/i)) { return html_content.replace(/<\/body>/i, `${tag}</body>`); }

	return html_content + tag;
}

export async function inject_inspector(html_content: string): Promise<string> {
	const tag = `<script src="${DEV_CLIENT_ROUTES.inspector}" defer></script>`;

	if (html_content.match(/<\/body>/i)) { return html_content.replace(/<\/body>/i, `${tag}</body>`); }

	return html_content + tag;
}

// ---------------------------------------------------------------------------
// Dev client script endpoint (GET /__ree_client/<name>.js)
// ---------------------------------------------------------------------------

/**
 * Dev client scripts exposed as external files instead of streamed inline into
 * every HTML page. The three files are the same ones the injectors above used
 * to inline; serving them as responses keeps ~60 KB of unminified JS out of
 * every dev page render, gives the scripts real entries (and working
 * breakpoints) in the browser debugger, and keeps the page HTML cacheable
 * separately from the scripts.
 *
 * GET handler only - served in dev mode from the same `__` endpoint block as
 * the issue reporter, so production never exposes it (the injectors above run
 * only when is_dev is true). Cache-Control is no-store so an edit to a client
 * script is picked up on the next reload without any cache busting.
 */
export const DEV_CLIENT_ROUTES = {
	livereload: "/__ree_client/livereload.js",
	issue_reporter: "/__ree_client/issue_reporter.js",
	inspector: "/__ree_client/inspector.js",
} as const;

const DEV_CLIENT_FILES: Record<keyof typeof DEV_CLIENT_ROUTES, { read: () => Promise<string>; }> = {
	livereload: { read: get_client_script },
	issue_reporter: { read: get_issue_reporter_script },
	inspector: { read: get_inspector_script },
};

/**
 * Serve one of the dev client scripts by name. Returns null for unknown names
 * so the caller can fall through to normal routing (404). The name is derived
 * from the URL's last segment and must match a DEV_CLIENT_ROUTES key exactly.
 */
export async function handle_dev_client_request(url: URL): Promise<Response | null> {
	const match = /\/__ree_client\/([a-z_]+)\.js$/.exec(url.pathname);
	if (!match) return null;

	const name = match[1] as keyof typeof DEV_CLIENT_FILES;
	const entry = DEV_CLIENT_FILES[name];
	if (!entry) return null;

	return new Response(await entry.read(), {
		headers: {
			"Content-Type": "text/javascript; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

export function notify_clients() {
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "reload" })); }
	}
}

/**
 * Broadcast a CRUD mutation notification to connected browsers on the
 * "updates" channel. Payload shape (issue #336):
 *
 *   { route: "/frameworks", action: "updated", column: "id", value: "100",
 *     description: "Aleš edited the record" }
 *
 * The client-side marker script filters by `route` and record `value`, so a
 * browser on a different page or listing different rows ignores the message.
 * Sent to every open socket - livereload-only clients ignore non-"reload"
 * types, updates clients act on "updates".
 */
export function notify_updates(payload: { route: string; action: string; column: string; value: string; description?: string }) {
	const message = JSON.stringify({ type: "updates", ...payload });
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) { ws.send(message); }
	}
}

/**
 * Tell connected browsers that a ReeQA evidence video for `run_id` finished,
 * so an open report page can reload itself. Targeted (unlike `reload`, which
 * livereload sends on hot reload) - the report page's own client matches the
 * run id before acting.
 */
export function notify_evidence_ready(run_id: string, page_id: string, video_path?: string, error?: string) {
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "reeqa_evidence_ready", run_id, page_id, video_path, error }));
		}
	}
}

/**
 * Tell connected browsers that a ReeQA recording clip for `run_id` finished,
 * so an open report page can swap its "recording" notice for the video in
 * place - the mode-3 sibling of notify_evidence_ready, kept separate since it
 * targets its own DOM markers (page.recording_path, not page.video_path).
 */
export function notify_recording_ready(run_id: string, page_id: string, recording_path?: string, error?: string) {
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "reeqa_recording_ready", run_id, page_id, recording_path, error }));
		}
	}
}
