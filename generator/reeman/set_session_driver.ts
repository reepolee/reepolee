#!/usr/bin/env bun
/**
 * Set session driver - switch between Redis and DB-backed
 */

import { join } from "node:path";

import { BOLD, color, CYAN, dim, GREEN, header, select_from_list, YELLOW } from "./ui";

export async function set_session_driver(): Promise<void> {
	header("Session driver");

	const driver_items = [
		{
			value: "auto",
			label: "Auto (DB-backed) - Inferred from CONNECTION_STRING (MySQL or SQLite sessions table)",
		},
		{
			value: "redis",
			label: "Redis - Redis / Valkey, sets REDIS_URL (default redis://localhost:6379)",
		},
	];

	const driver_choice = await select_from_list("Select session driver", driver_items);

	if (!driver_choice) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	const is_redis = driver_choice === "redis";
	const driver = is_redis ? "redis" : "auto";

	console.log(`  ${color("✓", GREEN)} Selected: ${color(BOLD + driver.toUpperCase(), CYAN)}`);

	const env_path = join(process.cwd(), ".env");
	const env_content_raw = await Bun.file(env_path).text();
	const env_lines = env_content_raw.split("\n");
	let env_modified = false;

	if (is_redis) {
		let found_redis = false;
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i].trim();
			const match = trimmed.match(/^#\s*(REDIS_URL=.*)/);
			if (match) {
				env_lines[i] = match[1];
				env_modified = true;
				found_redis = true;
				break;
			}
		}
		if (!found_redis) {
			env_lines.push("REDIS_URL=\"redis://localhost:6379\"");
			env_modified = true;
		}

		let found_session_store = false;
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i].trim();
			const match = trimmed.match(/^#?\s*(?:export\s+)?SESSION_STORE=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/);
			if (match) {
				const value = match[1] ?? match[2] ?? match[3] ?? "";
				if (value !== "redis") {
					env_lines[i] = "SESSION_STORE=\"redis\"";
					env_modified = true;
				}
				found_session_store = true;
				break;
			}
		}
		if (!found_session_store) {
			env_lines.push("SESSION_STORE=\"redis\"");
			env_modified = true;
		}

		console.log(`  ${color("✓", GREEN)} Enabled Redis session store`);
		console.log(`  ${dim("  Make sure REDIS_URL is correct in .env")}`);
	} else {
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i].trim();
			if (/^REDIS_URL=/.test(trimmed) && !trimmed.startsWith("#")) {
				env_lines[i] = `# ${trimmed}`;
				env_modified = true;
				break;
			}
		}

		let found_session_store = false;
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i].trim();
			const match = trimmed.match(/^#?\s*(?:export\s+)?SESSION_STORE=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/);
			if (match) {
				const value = match[1] ?? match[2] ?? match[3] ?? "";
				if (value !== "sql") {
					env_lines[i] = "SESSION_STORE=\"sql\"";
					env_modified = true;
				}
				found_session_store = true;
				break;
			}
		}
		if (!found_session_store) {
			env_lines.push("SESSION_STORE=\"sql\"");
			env_modified = true;
		}

		console.log(`  ${color("✓", GREEN)} Auto session store (MySQL / SQLite from CONNECTION_STRING)`);
	}

	if (env_modified) {
		await Bun.write(env_path, env_lines.join("\n"));
		console.log(`  ${color("✓", GREEN)} Updated .env`);
	} else {
		console.log(`  ${dim("  (.env already up to date)")}`);
	}

	console.log(`\n  ${color("✓ Done", GREEN)} Session driver set to ${driver.toUpperCase()}. Restart the server for changes to take effect.`);
}
