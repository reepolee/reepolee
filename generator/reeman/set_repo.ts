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

/** Replace the configured issue-report repositories with an ordered valid list. */
export async function set_repos(repos: string[], project_root = process.cwd()): Promise<void> {
	if (repos.length === 0 || repos.some((repo) => !OWNER_REPO_RE.test(repo)) || new Set(repos).size !== repos.length) {
		throw new Error("Repository list must contain unique owner/repo entries");
	}

	const pkg_path = join(project_root, "package.json");
	const pkg = await Bun.file(pkg_path).json();
	pkg.ree ??= {};
	pkg.ree.issue_repo = repos;
	await Bun.write(pkg_path, `${JSON.stringify(pkg, null, "\t")}\n`);
}

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

	// issue_repo is a list of "owner/repo" targets - the first entry is the
	// default for dev-mode issue reports and the rest are offered as choices in
	// the New Issue dialog. set-repo appends a repo rather than replacing the
	// list, so several linked repos can coexist.
	const pkg_path = join(process.cwd(), "package.json");
	const pkg = await Bun.file(pkg_path).json();
	const raw = pkg.ree?.issue_repo;
	const existing = Array.isArray(raw) ? raw.map(String) : (raw ? [String(raw)] : []);
	const next = [...new Set([...existing, target])];
	await set_repos(next);
	console.log(`  ${color("✓", GREEN)} Updated package.json (ree.issue_repo)`);

	console.log(`\n  ${color("✓ Done", GREEN)} Repository set to ${target}.`);
	await show_cli_tip(`bun reeman set-repo ${target}`, `Set repository: ${target}`);

	return target;
}
