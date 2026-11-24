#!/usr/bin/env bun
/**
 * Set session driver - switch between Redis and DB-backed
 */

import { join } from "node:path";

import { BOLD, color, CYAN, dim, GREEN, header, select_from_list, show_cli_tip, YELLOW } from "./ui";

/**
 * Set `name="value"` in a list of .env lines, replacing an existing assignment
 * (commented or not) or appending when there is none.
 *
 * Returns true when the file content actually changed, so the caller can skip
 * the write.
 */
function set_env_line(env_lines: string[], name: string, value: string): boolean {
	const assignment = `${name}="${value}"`;
	const pattern = new RegExp(`^#?\\s*(?:export\\s+)?${name}=`);

	for (let i = 0; i < env_lines.length; i++) {
		const trimmed = env_lines[i]!.trim();
		if (!pattern.test(trimmed)) continue;
		if (env_lines[i] === assignment) return false;
		env_lines[i] = assignment;
		return true;
	}

	env_lines.push(assignment);
	return true;
}

/**
 * Switch the session driver and update .env (REDIS_ENABLED / SESSION_STORE).
 *
 * Redis is turned off through REDIS_ENABLED="false", never by commenting out
 * REDIS_URL. The URL is the developer's own setting - it may point at a shared
 * or awkward-to-retype instance - and rewriting it to switch a feature off
 * destroys configuration that has nothing to do with the choice being made.
 * REDIS_ENABLED exists precisely so the URL can stay put; see redis_available()
 * in config/env_vars.ts.
 *
 * @param driver - "auto" or "redis". When omitted, prompts for selection.
 */
export async function set_session_driver(driver?: "auto" | "redis"): Promise<void> {
	let driver_choice: string;

	if (driver) {
		driver_choice = driver;
	} else {
		header("Session driver");

		const driver_items = [
			{
				value: "auto",
				label: "Auto (DB-backed) - Inferred from DEV_CONNECTION_STRING (MySQL or SQLite sessions table)",
			},
			{
				value: "redis",
				label: "Redis - Redis / Valkey, sets REDIS_URL (default redis://localhost:6379)",
			},
		];

		driver_choice = await select_from_list("Select session driver", driver_items);

		if (!driver_choice) {
			console.log(`  ${color("Cancelled.", YELLOW)}`);
			return;
		}
	}

	const is_redis = driver_choice === "redis";
	const resolved_driver = is_redis ? "redis" : "auto";

	console.log(`  ${color("✓", GREEN)} Selected: ${color(BOLD + resolved_driver.toUpperCase(), CYAN)}`);

	const env_path = join(process.cwd(), ".env");
	const env_content_raw = await Bun.file(env_path).text();
	const env_lines = env_content_raw.split("\n");
	let env_modified = false;

	if (is_redis) {
		// Three cases, and only the last one may write a URL: already set (leave
		// it alone), commented out by an older version of this command (restore
		// it verbatim), or absent (seed the default). Matching only the commented
		// form used to mean an existing, uncommented REDIS_URL counted as "not
		// found" and got a second, default-valued line appended after it.
		let found_redis = false;
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i]!.trim();
			if (!/^#?\s*(?:export\s+)?REDIS_URL=/.test(trimmed)) continue;

			const commented = trimmed.match(/^#\s*((?:export\s+)?REDIS_URL=.*)/);
			if (commented) {
				env_lines[i] = commented[1]!;
				env_modified = true;
			}
			found_redis = true;
			break;
		}
		if (!found_redis) {
			env_lines.push("REDIS_URL=\"redis://localhost:6379\"");
			env_modified = true;
		}

		if (set_env_line(env_lines, "REDIS_ENABLED", "true")) { env_modified = true; }

		let found_session_store = false;
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i]!.trim();
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
		// REDIS_URL is left exactly as the developer wrote it - only the switch moves.
		if (set_env_line(env_lines, "REDIS_ENABLED", "false")) { env_modified = true; }

		let found_session_store = false;
		for (let i = 0; i < env_lines.length; i++) {
			const trimmed = env_lines[i]!.trim();
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

		console.log(`  ${color("✓", GREEN)} Auto session store (MySQL / SQLite from DEV_CONNECTION_STRING)`);
	}

	if (env_modified) {
		await Bun.write(env_path, env_lines.join("\n"));
		console.log(`  ${color("✓", GREEN)} Updated .env`);
	} else {
		console.log(`  ${dim("  (.env already up to date)")}`);
	}

	console.log(`\n  ${color("✓ Done", GREEN)} Session driver set to ${resolved_driver.toUpperCase()}. Restart the server for changes to take effect.`);
	await show_cli_tip(`bun reeman set-session-driver ${resolved_driver}`, `Set session driver: ${resolved_driver}`);
}
