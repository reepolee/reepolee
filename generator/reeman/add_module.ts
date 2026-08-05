#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join } from "node:path";

import { add_module_route_entry } from "./utils/routes_writer";
import { ask, color, dim, GREEN, header, show_cli_tip, YELLOW } from "./ui";

const MODULE_CODE = /^[a-z][a-z0-9_]*$/;

export interface ModuleDatabase {
	has_module(module_code: string): Promise<boolean>;
	insert_module(module_code: string, module_name: string): Promise<void>;
}

export interface AddModuleOptions {
	project_root?: string;
	database?: ModuleDatabase;
}

export interface AddModuleResult {
	module_inserted: boolean;
	route_registered: boolean;
}

export async function add_module(module_code: string, options: AddModuleOptions = {}): Promise<AddModuleResult> {
	const normalized_code = validate_module_code(module_code);
	const project_root = options.project_root ?? process.cwd();
	const routes_path = join(project_root, "routes", "routes.ts");
	if (!existsSync(routes_path)) {
		throw new Error(`Route registry not found: routes/routes.ts`);
	}

	const routes_file = Bun.file(routes_path);
	const routes_content = await routes_file.text();
	const route_result = add_module_route_entry(routes_content, normalized_code);
	const database = options.database ?? await create_module_database();
	const module_exists = await database.has_module(normalized_code);

	let route_written = false;
	try {
		if (route_result.modified) {
			await Bun.write(routes_path, route_result.content);
			route_written = true;
		}

		if (!module_exists) {
			const module_name = module_display_name(normalized_code);
			await database.insert_module(normalized_code, module_name);
		}
	} catch (error) {
		if (route_written) { await Bun.write(routes_path, routes_content); }
		throw error;
	}

	const route_status = route_result.modified ? "Registered" : "Already registered";
	const module_status = module_exists ? "Already present" : "Added";
	console.log(`  ${color("✓", GREEN)} ${route_status}: routes/${normalized_code}`);
	console.log(`  ${color("✓", GREEN)} ${module_status}: modules.${normalized_code}`);

	return {
		module_inserted: !module_exists,
		route_registered: route_result.modified,
	};
}

export async function run_add_module(): Promise<AddModuleResult> {
	header("Add module");

	let module_code = "";
	while (true) {
		const input = await ask("Module folder name (saved lowercase)");
		try {
			module_code = validate_module_code(input);
		} catch (err) {
			console.log(`  ${color(`${err}`, YELLOW)}`);
			continue;
		}

		const trimmed_input = input.trim();
		if (module_code !== trimmed_input) {
			console.log(`  ${dim(`"${trimmed_input}" will be saved as "${module_code}"`)}`);
		}
		break;
	}

	const result = await add_module(module_code);
	await show_cli_tip(`bun reeman add-module ${module_code}`, `Added module: ${module_code}`);
	return result;
}

export function validate_module_code(module_code: string): string {
	const trimmed_code = module_code.trim();
	const normalized_code = trimmed_code.toLowerCase();
	if (!MODULE_CODE.test(normalized_code)) {
		throw new Error(`Module name "${trimmed_code}" is not valid. Use snake_case: start with a letter, then letters, digits or underscores (for example "sales" or "studio_tools").`);
	}
	return normalized_code;
}

export function module_display_name(module_code: string): string {
	const words = module_code.split("_");
	const titled_words = words.map((word) => {
		const first_character = word.charAt(0);
		const first_letter = first_character.toUpperCase();
		return first_letter + word.slice(1);
	});
	return titled_words.join(" ");
}

async function create_module_database(): Promise<ModuleDatabase> {
	const db_module = await import("$config/db_cli");
	const db_cli = db_module.db_cli;
	return {
		async has_module(module_code: string): Promise<boolean> {
			const rows = await db_cli`SELECT code FROM modules WHERE code = ${module_code} LIMIT 1`;
			return rows.length > 0;
		},
		async insert_module(module_code: string, module_name: string): Promise<void> {
			await db_cli`INSERT INTO modules (code, name) VALUES (${module_code}, ${module_name})`;
		},
	};
}
