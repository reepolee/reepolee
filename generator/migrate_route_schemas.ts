#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readdir, rename, rmdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { MAIN_APP, REEMAN_APP } from "$config/paths";

const LEGACY_SCHEMA_FILES = [
	["table.ts", "config.ts"],
	["table.generated.ts", "schema.generated.ts"],
	["validation_server.ts", "validation_server.ts"],
] as const;

export interface RouteSchemaMigrationResult {
	route_dir: string;
	moved: string[];
}

async function write_atomic(path: string, content: string): Promise<void> {
	const temp_path = `${path}.migration-${process.pid}`;
	await Bun.write(temp_path, content);
	await rename(temp_path, path);
}

export async function migrate_route_schema(route_dir: string): Promise<RouteSchemaMigrationResult> {
	const schema_dir = join(route_dir, "schema");
	const moves: Array<{ source: string; destination: string; destination_name: string; }> = [];

	for (const [legacy_name, destination_name] of LEGACY_SCHEMA_FILES) {
		const source = join(schema_dir, legacy_name);
		const destination = join(route_dir, destination_name);
		const source_exists = existsSync(source);
		const destination_exists = existsSync(destination);
		if (source_exists && destination_exists) {
			throw new Error(`Schema migration conflict: both ${source} and ${destination} exist`);
		}
		if (source_exists) moves.push({ source, destination, destination_name });
	}

	for (const move of moves) await rename(move.source, move.destination);

	const config_path = join(route_dir, "config.ts");
	if (existsSync(config_path)) {
		const config_content = await Bun.file(config_path).text();
		const migrated_content = config_content.replaceAll("./table.generated", "./schema.generated");
		if (migrated_content !== config_content) await write_atomic(config_path, migrated_content);
	}

	if (existsSync(schema_dir)) {
		const remaining_entries = await readdir(schema_dir);
		if (remaining_entries.length === 0) await rmdir(schema_dir);
	}

	return { route_dir, moved: moves.map((move) => move.destination_name) };
}

async function find_legacy_route_dirs(root_dir: string, excluded_route_dirs: Set<string>): Promise<string[]> {
	if (!existsSync(root_dir)) return [];
	const route_dirs = new Set<string>();
	const pending_dirs = [root_dir];
	while (pending_dirs.length > 0) {
		const current_dir = pending_dirs.pop();
		if (!current_dir) continue;
		const entries = await readdir(current_dir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const entry_path = join(current_dir, entry.name);
			if (entry.name === "schema") {
				const schema_entries = await readdir(entry_path);
				const has_legacy_file = LEGACY_SCHEMA_FILES.some(([legacy_name]) => schema_entries.includes(legacy_name));
				if (has_legacy_file && !excluded_route_dirs.has(current_dir)) route_dirs.add(current_dir);
				continue;
			}
			pending_dirs.push(entry_path);
		}
	}
	return [...route_dirs].sort();
}

export async function assert_no_legacy_route_schema_paths(root_dirs: string[], excluded_route_dirs: string[] = []): Promise<void> {
	const remaining: string[] = [];
	const excluded = new Set(excluded_route_dirs);
	for (const root_dir of root_dirs) {
		const route_dirs = await find_legacy_route_dirs(root_dir, excluded);
		remaining.push(...route_dirs);
	}
	if (remaining.length > 0) {
		throw new Error(`Legacy route schema paths remain:\n${remaining.join("\n")}`);
	}
}

export async function migrate_route_schemas(root_dirs: string[], excluded_route_dirs: string[] = []): Promise<RouteSchemaMigrationResult[]> {
	const route_dirs: string[] = [];
	const excluded = new Set(excluded_route_dirs);
	for (const root_dir of root_dirs) {
		const discovered_dirs = await find_legacy_route_dirs(root_dir, excluded);
		route_dirs.push(...discovered_dirs);
	}
	const results: RouteSchemaMigrationResult[] = [];
	for (const route_dir of route_dirs) results.push(await migrate_route_schema(route_dir));
	await assert_no_legacy_route_schema_paths(root_dirs, excluded_route_dirs);
	return results;
}

if (import.meta.main) {
	const root_dirs = [join(process.cwd(), MAIN_APP), join(process.cwd(), REEMAN_APP)];
	const excluded_route_dirs = [join(process.cwd(), REEMAN_APP, "locales")];
	const results = await migrate_route_schemas(root_dirs, excluded_route_dirs);
	for (const result of results) {
		console.log(`${basename(result.route_dir)}: ${result.moved.join(", ") || "already migrated"}`);
	}
	console.log(`Migrated ${results.length} route schema directories.`);
}
