#!/usr/bin/env bun
/**
 * Simple Page flow - interactive parameter collection for static pages.
 * Extracted from index.ts to keep the orchestrator thin.
 */

import { get_available_modules } from "../db";
import { generate_simple_page } from "../simple_page";
import { ask, BOLD, color, confirm, CYAN, dim, GREEN, header, MAGENTA, RED, select_from_list, YELLOW } from "../ui";
import { run_reettier } from "../utils/reeformat";

/**
 * Run the simple page interactive flow.
 * Returns true if execution completed, false if cancelled.
 */
export async function run_simple_page_flow(): Promise<boolean> {
	header("Route prefix");

	const modules = await get_available_modules();

	const prefix_items = [
		{ value: "", label: "(none) - no prefix, place directly in /routes" },
		...modules.map((m) => ({ value: m.code, label: `${m.code} - ${m.name}` })),
	];
	const prefix = await select_from_list("Select prefix", prefix_items);

	if (prefix) {
		console.log(`  ${color("✓", GREEN)} Prefix: ${color(BOLD + prefix, CYAN)}`);
	} else {
		console.log(`  ${dim("  (no prefix)")}`);
	}

	header("Route folder name");

	const raw_name = await ask("Folder name (e.g. 'my_page')");
	if (!raw_name || !/^[a-z0-9][a-z0-9_-]*$/.test(raw_name)) {
		console.log(`  ${color("Invalid folder name. Returning to menu.", RED)}`);
		return false;
	}

	console.log(`  ${color("✓", GREEN)} Folder: ${color(BOLD + raw_name, CYAN)}`);

	header("Ready to go");

	console.log(`\n${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color(`${BOLD}Summary`, MAGENTA)}`);
	console.log(`${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color("Command:", BOLD)}     Simple Page`);
	console.log(`  ${color("Folder:", BOLD)}      ${raw_name}`);
	if (prefix) console.log(`  ${color("Prefix:", BOLD)}      ${prefix}`);
	console.log(`${color("-".repeat(50), CYAN)}`);

	const proceed = await confirm("Create the Simple Page now?", "y");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return false;
	}

	await generate_simple_page(prefix, raw_name);

	const simple_page_rel = `routes${prefix ? `/${prefix}` : ""}/${raw_name}`;
	run_reettier(simple_page_rel);

	return true;
}
