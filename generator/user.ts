#!/usr/bin/env bun

/**
 * Dev helper: create a confirmed user directly in the database, bypassing the invite flow.
 *
 * Usage:
 * bun generator/user <username> <email> <password> [--modules <mod1,mod2>] [--prod]
 *
 * Examples:
 * bun generator/user alice alice@example.com secret123
 * bun generator/user admin admin@example.com s3cret --modules admin,editor
 */

import { create_user } from "./user_lib";
import { require_env } from "$lib/env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function print_usage() {
	console.error("Usage: bun generator/user <username> <email> <password> [--modules <mod1,mod2>] [--prod]");
	console.error("");
	console.error("Create a confirmed user directly in the database (no invite flow).");
	console.error("");
	console.error("Arguments:");
	console.error("  username              User's unique username");
	console.error("  email                 User's email address");
	console.error("  password              Plain-text password (hashed before storage)");
	console.error("");
	console.error("Flags:");
	console.error("  --modules <modules>   Comma-separated module tags (default: \"user\")");
	console.error("  --prod                Use PROD_CONNECTION_STRING instead of the development database");
	console.error("  --quiet               Suppress the success line (used by the installer)");
	console.error("  --help                Print this usage and exit");
	console.error("");
	console.error("Examples:");
	console.error("  bun generator/user alice alice@example.com secret123");
	console.error("  bun generator/user admin admin@example.com s3cret --modules admin,editor");
	console.error("  bun generator/user admin admin@example.com s3cret --prod");
}

function error_and_exit(message: string): never {
	console.error(`Error: ${message}`);
	console.error("");
	print_usage();
	process.exit(1);
}

function parse_args() {
	const args = process.argv.slice(2);

	if (args.includes("--help")) {
		print_usage();
		process.exit(0);
	}

	let username = "";
	let email = "";
	let password = "";
	let quiet = false;
	let prod = false;
	const modules_parts: string[] = [];
	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg === "--quiet") {
			quiet = true;
		} else if (arg === "--prod") {
			prod = true;
		} else if (arg === "--modules") {
			// Consume all following non-flag args as module values
			while (args[i + 1] && !args[i + 1]!.startsWith("--")) {
				i++;
				modules_parts.push(...(args[i] ?? "").split(","));
			}
		} else if (!arg.startsWith("--")) {
			positionals.push(arg);
		} else {
			error_and_exit(`Unknown flag "${arg}"`);
		}
	}

	if (positionals.length < 1) error_and_exit("Username is required");
	if (positionals.length < 2) error_and_exit("Email is required");
	if (positionals.length < 3) error_and_exit("Password is required");

	username = positionals[0] ?? "";
	email = positionals[1] ?? "";
	password = positionals[2] ?? "";
	const modules = modules_parts.length > 0 ? modules_parts.join(",") : "";

	return { username, email, password, modules, quiet, prod };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const { username, email, password, modules, quiet, prod } = parse_args();
	const connection_string = prod ? require_env("PROD_CONNECTION_STRING") : undefined;

	try {
		const result = await create_user(username, email, password, modules, connection_string);
		if (!quiet) { console.log(`\u2713 Created user ${result.username}`); }
		process.exit(0);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`\u2717 ${message}`);
		process.exit(1);
	}
}

await main();
