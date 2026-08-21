import { join } from "node:path";

// Data attached at server.upgrade(req, { data: {...} }) - the only WebSocket
// use in this app. `locale` is captured once at upgrade time (from the
// `locale` cookie, same resolution as lib/route.ts's resolve_locale) so
// inspector i18n messages on this connection resolve against the same
// locale the page was rendered in.
export type WebSocketData = { type: "livereload"; locale: string; };

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
export async function inject_live_reload(html_content: string): Promise<string> {
	const script = await get_client_script();
	const tag = `<script>
		${script};
	</script>`;

	if (html_content.match(/<\/body>/i)) { return html_content.replace(/<\/body>/i, `${tag}</body>`); }

	return html_content + tag;
}

export async function inject_issue_reporter(html_content: string): Promise<string> {
	const script = await get_issue_reporter_script();
	const tag = `<script>
		${script};
	</script>`;

	if (html_content.match(/<\/body>/i)) { return html_content.replace(/<\/body>/i, `${tag}</body>`); }

	return html_content + tag;
}

export async function inject_inspector(html_content: string): Promise<string> {
	const script = await get_inspector_script();
	const tag = `<script>
		${script};
	</script>`;

	if (html_content.match(/<\/body>/i)) { return html_content.replace(/<\/body>/i, `${tag}</body>`); }

	return html_content + tag;
}

export function notify_clients() {
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "reload" })); }
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
