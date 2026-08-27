#!/usr/bin/env bun
/**
 * Set repository - link this project to a GitHub repo (owner/repo).
 *
 * Writes package.json "ree.issue_repo" only. Does not touch git remotes or the
 * standard npm "repository"/"bugs" fields - this is deliberately a separate,
 * reeman-specific setting so it can't be confused with (or overwritten by) npm
 * package metadata. Consumed by lib/issue_reporter.ts to decide where dev-mode
 * "New Issue" reports (Ctrl+Shift+I) get filed, independent of the local git
 * origin.
 */

import { join } from "node:path";

import { ask, BOLD, color, CYAN, GREEN, header, RED, show_cli_tip, YELLOW } from "./ui";

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Prompt for a GitHub "owner/repo" and write it into package.json.
 * Pass owner_repo to skip the prompt (used by the CLI).
 */
export async function set_repo(owner_repo?: string): Promise<string | null> {
	header("Repository");

	let target = owner_repo?.trim();

	if (!target) {
		console.log(`  ${color("Link this project to a GitHub repo so dev-mode issue reports (Ctrl+Shift+I) go to the right place.", YELLOW)}`);
		const input = await ask("GitHub repo (owner/repo), or leave blank to skip");
		target = input.trim();
	}

	if (!target) {
		console.log(`  ${color("Skipped.", YELLOW)}`);
		return null;
	}

	if (!OWNER_REPO_RE.test(target)) {
		console.log(`  ${color(`✗ Invalid format: "${target}" - expected owner/repo`, RED)}`);
		return null;
	}

	console.log(`  ${color("✓", GREEN)} Repository: ${color(BOLD + target, CYAN)}`);

	const pkg_path = join(process.cwd(), "package.json");
	const pkg = await Bun.file(pkg_path).json();
	pkg.ree ??= {};
	pkg.ree.issue_repo = target;
	await Bun.write(pkg_path, `${JSON.stringify(pkg, null, "\t")}\n`);
	console.log(`  ${color("✓", GREEN)} Updated package.json (ree.issue_repo)`);

	console.log(`\n  ${color("✓ Done", GREEN)} Repository set to ${target}.`);
	await show_cli_tip(`bun reeman set-repo ${target}`, `Set repository: ${target}`);

	return target;
}
