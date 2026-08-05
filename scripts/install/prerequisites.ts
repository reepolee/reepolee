#!/usr/bin/env bun

/**
 * Prerequisite fetcher - replaces the nine-command `&&` chain that `get:pre`
 * used to be. Driving them from one script stops Bun from echoing a `$ ...`
 * line per command, gives the plain-curl downloads (which printed nothing) a
 * reported result, and lets the independent downloads run concurrently.
 *
 * Versions are read from package.json's `get:*` scripts so this file never
 * becomes a second place a version has to be bumped.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { section, set_verbose, step_done, step_fail, step_start } from "./reporter";

import { install_reesql } from "./reesql";
import { install_reettier } from "./reettier";
import { install_tailwind } from "./tailwind";
import { install_vips } from "./vips";
import { install_zod_types } from "./zod_types";

type download = { label: string; version: string; url: string; out: string; license_url: string; };

async function read_scripts(): Promise<Record<string, string>> {
	const pkg_path = join(process.cwd(), "package.json");
	const pkg = await Bun.file(pkg_path).json();
	const scripts = pkg.scripts ?? {};
	return scripts;
}

// Pull "<pkg>@<version>" out of a get:* script so versions stay single-sourced.
function extract_version(script: string, pkg_name: string): string {
	const escaped = pkg_name.replace(/[/@\-.]/g, "\\$&");
	const pattern = new RegExp(`${escaped}@([\\d.]+)`);
	const match = script.match(pattern);
	const version = match?.[1];
	if (!version) { throw new Error(`Could not read ${pkg_name} version from package.json`); }
	return version;
}

// get:vips/get:tw pass the version as a --version= flag, not an npm @version spec.
function extract_flag_version(script: string, label: string): string {
	const match = script.match(/--version=([\d.]+)/);
	const version = match?.[1];
	if (!version) { throw new Error(`Could not read ${label} version from package.json`); }
	return version;
}

async function fetch_to_file(url: string, out_path: string): Promise<void> {
	const res = await fetch(url);
	if (!res.ok) { throw new Error(`GET ${url} -> ${res.status}`); }
	const buf = await res.arrayBuffer();
	await Bun.write(out_path, buf);
}

// Installers return a short detail string ("8.18.4 already installed") that
// becomes the trailing note on the reported line.
async function run_tool(label: string, fn: () => Promise<string>): Promise<void> {
	step_start(label);
	try {
		const detail = await fn();
		step_done(label, detail);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		step_fail(label, message);
		throw err;
	}
}

async function main() {
	const args = process.argv.slice(2);
	const is_verbose = args.includes("--verbose");
	set_verbose(is_verbose);

	const scripts = await read_scripts();

	const zod_version = extract_version(scripts["get:zod"] ?? "", "zod");
	const hljs_version = extract_version(scripts["get:hljs"] ?? "", "highlight.js");
	const temporal_version = extract_version(scripts["get:temporal"] ?? "", "@js-temporal/polyfill");
	const tw_version = extract_flag_version(scripts["get:tw"] ?? "", "tailwindcss");
	const vips_version = extract_flag_version(scripts["get:vips"] ?? "", "vips");

	await Promise.all([
		mkdir(join(process.cwd(), "vendor"), { recursive: true }),
		mkdir(join(process.cwd(), "static"), { recursive: true }),
	]);

	const downloads: download[] = [
		{
			label: "zod",
			version: zod_version,
			url: `https://cdn.jsdelivr.net/npm/zod@${zod_version}/+esm`,
			out: join("vendor", "zod.min.js"),
			license_url: `https://cdn.jsdelivr.net/npm/zod@${zod_version}/LICENSE`,
		},
		{
			label: "highlight.js",
			version: hljs_version,
			url: `https://cdn.jsdelivr.net/npm/highlight.js@${hljs_version}/+esm`,
			out: join("vendor", "highlight.min.js"),
			license_url: `https://cdn.jsdelivr.net/npm/highlight.js@${hljs_version}/LICENSE`,
		},
		{
			label: "temporal",
			version: temporal_version,
			url: `https://esm.sh/@js-temporal/polyfill@${temporal_version}/es2022/polyfill.bundle.mjs`,
			out: join("vendor", "temporal.min.js"),
			license_url: `https://cdn.jsdelivr.net/npm/@js-temporal/polyfill@${temporal_version}/LICENSE`,
		},
		{
			label: "dpu polyfill",
			version: "latest",
			url: "https://raw.githubusercontent.com/GoogleChromeLabs/html-setters-polyfill/main/index.min.js",
			out: join("static", "dpu.min.js"),
			license_url: "https://cdn.jsdelivr.net/npm/html-setters-polyfill/LICENSE",
		},
	];

	section("Prerequisites");

	// Downloads are independent of each other, but the reporter draws one line
	// at a time - so fetch concurrently, then report in a stable order.
	const download_tasks = downloads.map(async (item) => {
		const res = await fetch(item.url);
		if (!res.ok) { throw new Error(`GET ${item.url} -> ${res.status}`); }
		const body = await res.arrayBuffer();
		return { item, body };
	});

	const fetched = await Promise.allSettled(download_tasks);

	for (let i = 0; i < downloads.length; i++) {
		const item = downloads[i]!;
		const outcome = fetched[i]!;
		step_start(item.label);
		if (outcome.status === "rejected") {
			const reason = outcome.reason;
			const message = reason instanceof Error ? reason.message : String(reason);
			step_fail(item.label, message);
			throw new Error(`${item.label} download failed`);
		}
		await Bun.write(item.out, outcome.value.body);
		await fetch_to_file(item.license_url, `${item.out}.LICENSE.txt`);
		step_done(item.label, item.version);
	}

	await run_tool("zod types", install_zod_types);
	await run_tool("tailwindcss", () => install_tailwind({ version: tw_version, get_task: "get:tw" }));
	await run_tool("libvips", () => install_vips({ version: vips_version, get_task: "get:vips" }));
	await run_tool("reettier", install_reettier);
	await run_tool("reesql", install_reesql);
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`\u001b[31mPrerequisite install failed: ${message}\u001b[0m`);
	process.exit(1);
});
