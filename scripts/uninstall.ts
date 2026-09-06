#!/usr/bin/env bun

import { existsSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { forget_global_tool, global_tool_names, read_ownership_receipt, type global_tool_name } from "./install/ownership";

type command_result = { code: number; output: string; };

const home_dir = os.homedir();
const platform = os.platform();
const bin_dir = path.join(home_dir, "bin");

async function run_command(command: string, args: string[], inherit_output = true): Promise<command_result> {
	if (!inherit_output) {
		// Pipe stdio so stdout/stderr come back as streams, not fd numbers.
		let captured: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			captured = Bun.spawn([command, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { code: -1, output: message };
		}
		const stdout_promise = new Response(captured.stdout).text();
		const stderr_promise = new Response(captured.stderr).text();
		const code = await captured.exited;
		const parts = await Promise.all([stdout_promise, stderr_promise]);
		return { code, output: `${parts[0]}${parts[1]}` };
	}

	let inherited: Bun.Subprocess<"inherit", "inherit", "inherit">;
	try {
		inherited = Bun.spawn([command, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: -1, output: message };
	}
	const code = await inherited.exited;
	return { code, output: "" };
}

async function delete_file(file_path: string): Promise<void> {
	const file = Bun.file(file_path);
	const exists = await file.exists();
	if (exists) await file.delete();
}

async function remove_tailwind(): Promise<void> {
	const executable = platform === "win32" ? "tw.exe" : "tw";
	await delete_file(path.join(bin_dir, executable));
}

async function remove_typescript(): Promise<void> {
	const list_result = await run_command("bun", ["pm", "ls", "-g"], false);
	if (list_result.code !== 0) throw new Error("Could not inspect Bun global packages");
	if (!list_result.output.includes("typescript@")) return;

	const remove_result = await run_command("bun", ["remove", "-g", "typescript"]);
	if (remove_result.code !== 0) throw new Error(`bun remove -g typescript failed with ${remove_result.code}`);
}

async function remove_mac_vips(): Promise<void> {
	const list_result = await run_command("brew", ["list", "--versions", "vips"], false);
	if (list_result.code === -1) throw new Error("Homebrew is required to remove the Reepolee-installed libvips package");
	if (list_result.code !== 0 || !list_result.output.trim()) return;

	const remove_result = await run_command("brew", ["uninstall", "vips"]);
	if (remove_result.code !== 0) throw new Error(`brew uninstall vips failed with ${remove_result.code}`);
}

async function remove_linux_vips(): Promise<void> {
	const apt_result = await run_command("apt", ["--version"], false);
	if (apt_result.code === 0) {
		const remove_result = await run_command("sudo", ["apt", "remove", "-y", "libvips-dev"]);
		if (remove_result.code !== 0) throw new Error(`apt remove libvips-dev failed with ${remove_result.code}`);
		return;
	}

	const dnf_result = await run_command("dnf", ["--version"], false);
	if (dnf_result.code === 0) {
		const remove_result = await run_command("sudo", ["dnf", "remove", "-y", "vips-devel"]);
		if (remove_result.code !== 0) throw new Error(`dnf remove vips-devel failed with ${remove_result.code}`);
		return;
	}

	const pacman_result = await run_command("pacman", ["--version"], false);
	if (pacman_result.code === 0) {
		const remove_result = await run_command("sudo", ["pacman", "-R", "--noconfirm", "vips"]);
		if (remove_result.code !== 0) throw new Error(`pacman remove vips failed with ${remove_result.code}`);
		return;
	}

	throw new Error("Could not find the package manager that installed libvips");
}

function find_windows_vips_bin(): string | null {
	const install_dir = path.join(bin_dir, "vips");
	if (!existsSync(install_dir)) return null;

	const entries = readdirSync(install_dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("vips-dev-")) continue;
		const source_bin = path.join(install_dir, entry.name, "bin");
		if (existsSync(source_bin)) return source_bin;
	}
	return null;
}

async function remove_windows_vips(): Promise<void> {
	const source_bin = find_windows_vips_bin();
	if (source_bin) {
		const copied_entries = readdirSync(source_bin);
		for (const entry_name of copied_entries) {
			const copied_path = path.join(bin_dir, entry_name);
			if (existsSync(copied_path)) rmSync(copied_path, { recursive: true, force: true });
		}
	} else {
		await delete_file(path.join(bin_dir, "vips.exe"));
	}

	const install_dir = path.join(bin_dir, "vips");
	const cache_dir = path.join(home_dir, ".cache", "reepolee", "vips");
	if (existsSync(install_dir)) rmSync(install_dir, { recursive: true, force: true });
	if (existsSync(cache_dir)) rmSync(cache_dir, { recursive: true, force: true });
}

async function remove_vips(): Promise<void> {
	if (platform === "darwin") return remove_mac_vips();
	if (platform === "linux") return remove_linux_vips();
	if (platform === "win32") return remove_windows_vips();
	throw new Error(`Unsupported platform: ${platform}`);
}

async function remove_direct_tool(tool: "reettier" | "reesql"): Promise<void> {
	if (platform === "win32") {
		const windows_path = path.join(home_dir, "bin", `${tool}.exe`);
		await delete_file(windows_path);
		return;
	}

	const unix_path = path.join(home_dir, ".local", "bin", tool);
	await delete_file(unix_path);
}

async function remove_tool(tool: global_tool_name): Promise<void> {
	if (tool === "tailwindcss") return remove_tailwind();
	if (tool === "typescript") return remove_typescript();
	if (tool === "libvips") return remove_vips();
	if (tool === "reettier") return remove_direct_tool("reettier");
	if (tool === "reesql") return remove_direct_tool("reesql");
}

async function main(): Promise<void> {
	const is_dry_run = process.argv.includes("--dry-run");
	const is_force = process.argv.includes("--force");
	const receipt = await read_ownership_receipt();
	const selected_tools = is_force ? [...global_tool_names] : receipt.tools;
	if (selected_tools.length === 0) {
		console.log("No Reepolee-owned global prerequisites found.");
		console.log("Tools installed before ownership tracking are not removed automatically.");
		console.log("Use --force to remove all recognized global prerequisites regardless of ownership.");
		return;
	}

	const uninstall_order: global_tool_name[] = ["reesql", "reettier", "libvips", "typescript", "tailwindcss"];
	for (const tool of uninstall_order) {
		if (!selected_tools.includes(tool)) continue;
		if (is_dry_run) {
			console.log(`Would remove ${tool}`);
			continue;
		}

		console.log(`Removing ${tool}...`);
		await remove_tool(tool);
		await forget_global_tool(tool);
		console.log(`Removed ${tool}.`);
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[uninstall] Error: ${message}`);
	process.exit(1);
});
