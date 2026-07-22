import { join } from "node:path";

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

export const clients = new Set();
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
