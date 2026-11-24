type server_input = {
	isTTY?: boolean;
	setRawMode?: (mode: boolean) => void;
	resume: () => void;
	pause?: () => void;
	on: (event: "data", listener: (data: string | Uint8Array) => void) => void;
	removeListener?: (event: "data", listener: (data: string | Uint8Array) => void) => void;
};

type spawn_browser_process = (command: string[]) => unknown;

const spawn_browser: spawn_browser_process = (command) => Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });

export function open_browser_command(url: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "darwin") return ["open", url];
	if (platform === "win32") return ["cmd.exe", "/c", "start", "", url];
	return ["xdg-open", url];
}

export function listen_for_open_key(
	url: string,
	input: server_input = process.stdin as unknown as server_input,
	spawn: spawn_browser_process = spawn_browser,
	platform: NodeJS.Platform = process.platform,
): () => void {
	if (!input.isTTY) return () => {};

	input.setRawMode?.(true);
	input.resume();

	const on_data = (data: string | Uint8Array) => {
		const key = typeof data === "string" ? data : new TextDecoder().decode(data);
		if (key === "\u0003") {
			cleanup();
			process.kill(process.pid, "SIGINT");
			return;
		}
		if (key === "o" || key === "O") spawn(open_browser_command(url, platform));
	};
	const cleanup = () => {
		input.removeListener?.("data", on_data);
		input.setRawMode?.(false);
		input.pause?.();
		process.removeListener("exit", cleanup);
	};

	input.on("data", on_data);
	process.once("exit", cleanup);
	console.log(`    Press "o" to open ${url} in your browser`);

	return cleanup;
}
