import { mkdtempSync, rmSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { child_stdio, get_verbose } from "./reporter";

const VENDOR_DIR = join(process.cwd(), "vendor", "zod-types");

// Read the zod version from get:zod (package.json) instead of hardcoding a
// second copy here - the runtime bundle (vendor/zod.min.js) and these types
// must always match the same version, and a single source keeps them in sync
// when zod is bumped.
async function get_zod_version(): Promise<string> {
	const pkg = await Bun.file(join(process.cwd(), "package.json")).json();
	const get_zod_script: string = pkg.scripts?.["get:zod"] ?? "";
	const match = get_zod_script.match(/zod@([\d.]+)/);
	const version = match?.[1];
	if (!version) { throw new Error("Could not find zod version in package.json's get:zod script"); }
	return version;
}

function run(cmd: string, args: string[], opts?: { cwd?: string; }): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: child_stdio(), ...opts });
		p.on("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`${cmd} failed with ${code}`)); });
	});
}

// Recursively copy only .d.ts files from src to dest, creating directories as needed.
// Node's fs APIs (not shell cp/find) avoid Windows-path-vs-tar/cp argument quirks.
function copy_d_ts_tree(src: string, dest: string): void {
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src)) {
		const src_path = join(src, entry);
		const dest_path = join(dest, entry);
		if (statSync(src_path).isDirectory()) {
			copy_d_ts_tree(src_path, dest_path);
		} else if (entry.endsWith(".d.ts")) {
			copyFileSync(src_path, dest_path);
		}
	}
}

/**
 * Vendor zod's real .d.ts tree so `import { z } from "$vendor/zod.min.js"`
 * type-checks against zod's actual (v4) API instead of failing to resolve.
 *
 * zod.min.js (get:zod) is a single ESM bundle with no co-located types, so
 * this fetches the published npm tarball for the same version, keeps only
 * the .d.ts files (the runtime already comes from the bundle), and drops
 * them under vendor/zod-types/. vendor/zod.min.d.ts re-exports from here.
 */
export async function install_zod_types(): Promise<string> {
	const zod_version = await get_zod_version();
	const tmp_dir = mkdtempSync(join(tmpdir(), "zod-types-"));

	try {
		if (get_verbose()) { console.log(`[zod-types] Fetching zod@${zod_version} package tarball...`); }
		const tarball_path = join(tmp_dir, "zod.tgz");
		await run("curl", ["-fsSL", `https://registry.npmjs.org/zod/-/zod-${zod_version}.tgz`, "-o", tarball_path]);

		if (get_verbose()) { console.log("[zod-types] Extracting package..."); }
		// Bun.Archive auto-detects the gzip wrapper and validates entry paths
		// against traversal. Extracting in-process also sidesteps the platform
		// tar entirely - no Windows-style path ever reaches a tar argument, where
		// some builds misparse it as a remote host spec.
		const tarball = new Bun.Archive(await Bun.file(tarball_path).bytes());
		await tarball.extract(tmp_dir);

		rmSync(VENDOR_DIR, { recursive: true, force: true });
		mkdirSync(VENDOR_DIR, { recursive: true });

		const package_dir = join(tmp_dir, "package");
		copyFileSync(join(package_dir, "index.d.ts"), join(VENDOR_DIR, "index.d.ts"));
		copy_d_ts_tree(join(package_dir, "v4"), join(VENDOR_DIR, "v4"));

		if (get_verbose()) { console.log(`[zod-types] Installed to ${VENDOR_DIR}`); }
		return zod_version;
	} finally {
		rmSync(tmp_dir, { recursive: true, force: true });
	}
}
