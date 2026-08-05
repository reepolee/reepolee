import { join } from "node:path";

// Data attached at server.upgrade(req, { data: {...} }) - the only WebSocket use in this app.
export type WebSocketData = { type: "livereload"; };

let _client_script: string | null = null;

// @internal - for testing: pre-set the client script content without reading a file.
export function __set_client_script(content: string): void { _client_script = content; }

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

export function notify_clients() {
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "reload" })); }
	}
}
