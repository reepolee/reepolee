import { describe, expect, test } from "bun:test";

import type { WebSocketData } from "./livereload";
import { clients, DEV_CLIENT_ROUTES, handle_dev_client_request, inject_inspector, inject_issue_reporter, inject_live_reload, notify_clients, set_reload_broadcast, __set_client_script, __set_inspector_script, __set_issue_reporter_script } from "./livereload";

describe("dev client script endpoint", () => {
	test("serves the livereload client with a JS content type and no-store", async () => {
		__set_client_script("// test livereload client");
		const response = await handle_dev_client_request(new URL(DEV_CLIENT_ROUTES.livereload, "http://localhost"));
		expect(response).not.toBeNull();
		expect(response!.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
		expect(response!.headers.get("Cache-Control")).toBe("no-store");
		expect(await response!.text()).toBe("// test livereload client");
	});

	test("serves the inspector client via its test seam", async () => {
		__set_inspector_script("// test inspector client");
		const response = await handle_dev_client_request(new URL(DEV_CLIENT_ROUTES.inspector, "http://localhost"));
		expect(response).not.toBeNull();
		expect(await response!.text()).toBe("// test inspector client");
	});

	test("serves the issue reporter client via its test seam", async () => {
		__set_issue_reporter_script("// test issue reporter client");
		const response = await handle_dev_client_request(new URL(DEV_CLIENT_ROUTES.issue_reporter, "http://localhost"));
		expect(response).not.toBeNull();
		expect(await response!.text()).toBe("// test issue reporter client");
	});

	test("returns null for unknown script names so routing can 404", async () => {
		expect(await handle_dev_client_request(new URL("/__ree_client/unknown.js", "http://localhost"))).toBeNull();
	});

	test("returns null for non-endpoint paths", async () => {
		expect(await handle_dev_client_request(new URL("/", "http://localhost"))).toBeNull();
		expect(await handle_dev_client_request(new URL("/static/app.js", "http://localhost"))).toBeNull();
	});
});

describe("reload broadcast gate", () => {
	test("notify_clients sends nothing while the broadcast is disabled for this process", async () => {
		const sent: string[] = [];
		const fake_ws = {
			readyState: WebSocket.OPEN,
			send: (message: string) => { sent.push(message); },
		} as unknown as Bun.ServerWebSocket<WebSocketData>;
		clients.add(fake_ws);
		set_reload_broadcast(true);
		try {
			notify_clients();
			expect(sent).toHaveLength(1);
			expect(JSON.parse(sent[0]!)).toEqual({ type: "reload" });

			sent.length = 0;
			set_reload_broadcast(false);
			notify_clients();
			expect(sent).toHaveLength(0);
		} finally {
			set_reload_broadcast(true);
			clients.delete(fake_ws);
		}
	});
});

describe("dev client script injection", () => {
	test("injects a script src tag for live reload before </body>", async () => {
		const html = await inject_live_reload("<html><body><p>x</p></body></html>");
		expect(html).toContain(`<script src="${DEV_CLIENT_ROUTES.livereload}" defer></script></body>`);
		expect(html).not.toContain("<script>\n");
	});

	test("injects a script src tag for the issue reporter before </body>", async () => {
		const html = await inject_issue_reporter("<html><body></body></html>");
		expect(html).toContain(`<script src="${DEV_CLIENT_ROUTES.issue_reporter}" defer></script></body>`);
	});

	test("injects a script src tag for the inspector before </body>", async () => {
		const html = await inject_inspector("<html><body></body></html>");
		expect(html).toContain(`<script src="${DEV_CLIENT_ROUTES.inspector}" defer></script></body>`);
	});

	test("appends the tag when the document has no </body>", async () => {
		const html = await inject_live_reload("<p>fragment</p>");
		expect(html).toBe(`<p>fragment</p><script src="${DEV_CLIENT_ROUTES.livereload}" defer></script>`);
	});
});
