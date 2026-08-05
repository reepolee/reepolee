import os from "node:os";

import type { WebSocketData } from "$lib/livereload";
import type { RouteTable } from "$lib/middleware/types";
import { kill_port } from "$lib/port_release";
import { listen_for_open_key } from "$lib/server_controls";

export async function kill_previous_pid(pid_file: string | null): Promise<void> {
	if (!pid_file) return;

	const file = Bun.file(pid_file);
	if (!(await file.exists())) return;

	const pid_str = await file.text();
	const pid = Number(pid_str);
	if (!Number.isFinite(pid) || pid <= 0) return;

	if (!is_bun_process(pid)) {
		try {
			await Bun.write(pid_file, "");
		} catch {}
		return;
	}

	try {
		process.kill(pid, "SIGKILL");
		console.log(`  💀 Killed orphaned server PID ${pid}`);
	} catch {}

	try {
		await Bun.write(pid_file, "");
	} catch {}
}

function is_bun_process(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}

	try {
		const output = Bun.spawnSync({
			cmd: ["ps", "-p", String(pid), "-o", "comm="],
			stdout: "pipe",
			stderr: "pipe",
		});
		const decoder = new TextDecoder();
		const output_text = decoder.decode(output.stdout);
		const comm = output_text.trim();
		return comm.includes("bun");
	} catch {
		return false;
	}
}

export type ServerStartOptions = {
	is_dev: boolean;
	is_agent: boolean;
	is_test: boolean;
	routed: RouteTable;
	create_dev_fetch_handler: () => (req: Request, server: Bun.Server<WebSocketData>) => Promise<Response>;
	create_prod_fetch_handler: () => (req: Request, server: Bun.Server<WebSocketData>) => Promise<Response>;
	websocket_config: Bun.WebSocketHandler<WebSocketData>;
};

export async function start_server(opts: ServerStartOptions): Promise<Bun.Server<WebSocketData>> {
	const { is_dev, is_agent, is_test, routed, create_dev_fetch_handler, create_prod_fetch_handler, websocket_config } = opts;
	const port = is_agent && Bun.env.AGENT_SERVER_PORT ? Number(Bun.env.AGENT_SERVER_PORT) : is_test ? Number(Bun.env.TEST_PORT) || 2600 : Number(Bun.env.PORT) || 2338;

	console.log(`🔌 Releasing port ${port}...`);
	await kill_port(port);
	console.log(`🔌 Port ${port} ready`);

	const hostname = is_agent || is_test ? "127.0.0.1" : "0.0.0.0";
	if (is_dev) {
		return Bun.serve({ hostname, port, idleTimeout: 60, fetch: create_dev_fetch_handler(), websocket: websocket_config, development: true });
	}
	return Bun.serve({ hostname, port, idleTimeout: 60, routes: routed, fetch: create_prod_fetch_handler(), websocket: websocket_config });
}

export function log_server_addresses(server: Bun.Server<WebSocketData>, is_agent: boolean, is_dev: boolean, is_test: boolean): void {
	if (is_test) {
		console.log(`🧪 Test server ready at http://127.0.0.1:${server.port}`);
		return;
	}

	console.log(`🖥️ Dev server ready`);
	console.log("");
	const protocol = parseInt(Bun.env.PORT || "2338", 10) === 8443 ? "https" : "http";
	const display_host_raw = is_agent ? "localhost" : Bun.env.SERVER_NAME || "localhost";
	const display_host = display_host_raw.toLowerCase();
	const server_url = `${protocol}://${display_host}:${server.port}/`;
	console.log(`    \x1b[92m${server_url}\x1b[0m`);
	console.log("");
	if (!is_agent) {
		const nets = os.networkInterfaces();
		const ipv4_addrs: string[] = [];
		for (const name of Object.keys(nets)) {
			for (const net of nets[name] ?? []) {
				if (net.family === "IPv4" && !net.internal) ipv4_addrs.push(`${protocol}://${net.address}:${server.port}`);
			}
		}
		if (ipv4_addrs.length > 0) {
			console.log(`    Other addresses:`);
			for (const addr of ipv4_addrs) console.log(`    ${addr}`);
			console.log("");
		}
	}
	console.log(`    🔄 Live reload: active`);
	console.log("");
	listen_for_open_key(server_url);
}
