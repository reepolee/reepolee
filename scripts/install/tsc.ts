import { spawn } from "node:child_process";

import { child_stdio, get_verbose } from "./reporter";

function run_capture(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: "pipe" });
		let out = "";
		p.stdout!.on("data", (d: Buffer) => out += d.toString());
		p.stderr!.on("data", (d: Buffer) => out += d.toString());
		p.on("error", reject);
		p.on("exit", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`${cmd} failed with ${code}`));
		});
	});
}

async function get_installed_version(): Promise<string | null> {
	try {
		const raw = await run_capture("tsc", ["--version"]);
		const match = raw.match(/(\d+\.\d+\.\d+)/);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

function install_global(version: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn("bun", ["add", "-g", `typescript@${version}`], { stdio: child_stdio() });
		p.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`bun add -g typescript failed with ${code}`));
		});
		p.on("error", reject);
	});
}

export async function install_tsc({ version, get_task }: { version: string; get_task: string }): Promise<string> {
	if (get_verbose()) console.log(`[tsc] Requested version: ${version}`);

	const installed = await get_installed_version();

	if (get_verbose()) console.log(`[tsc] Installed: ${installed ?? "none"}`);

	if (installed === version) return "already installed";

	await install_global(version);

	const after = await get_installed_version();
	return installed ? "updated" : "added";
}
