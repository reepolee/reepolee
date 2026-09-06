import { env_var_description } from "$config/env_var_descriptions";

import { read_env_file, write_env_file } from "./env_file";

const ENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)(.*)$/;

export const RESOURCE_NAME = "environment";

export interface Item {
	id: string;
	key: string;
	value: string;
	description: string;
	edit_url: string;
}

function split_lines(content: string): string[] {
	return content.split(/\r?\n/);
}

function get_line_ending(content: string): string {
	return content.includes("\r\n") ? "\r\n" : "\n";
}

export async function get_all_items(project_root = process.cwd()): Promise<Item[]> {
	const env_file = await read_env_file(project_root);
	const records = new Map<string, Item>();
	const lines = split_lines(env_file.content);

	for (const line of lines) {
		const match = line.match(ENV_ASSIGNMENT_PATTERN);
		if (!match) continue;

		const key = match[2]!;
		const value = match[3]!;
		records.set(key, {
			id: key,
			key,
			value,
			description: env_var_description(key),
			edit_url: `/environment/${encodeURIComponent(key)}/edit`,
		});
	}

	return Array.from(records.values());
}

export async function get_item_by_id(id: string, project_root = process.cwd()): Promise<Item | null> {
	const records = await get_all_items(project_root);
	return records.find((record) => record.id === id) ?? null;
}

export async function search_items(
	search = "",
	offset = 0,
	limit = 20,
	order_by = "native::asc",
	project_root = process.cwd(),
): Promise<{ items: Item[]; total: number }> {
	const all_records = await get_all_items(project_root);
	const normalized_search = search.trim().toLowerCase();
	const filtered_records = normalized_search
		? all_records.filter((record) => {
			const search_text = `${record.key} ${record.value} ${record.description}`.toLowerCase();
			return search_text.includes(normalized_search);
		})
		: all_records;

	const [sort_field, sort_direction] = order_by.split("::");
	const sorted_records = sort_field === "native"
		? filtered_records
		: filtered_records.toSorted((left, right) => {
			const left_value = sort_field === "description" ? left.description : left.key;
			const right_value = sort_field === "description" ? right.description : right.key;
			const comparison = left_value.localeCompare(right_value);
			return sort_direction === "desc" ? -comparison : comparison;
		});

	return {
		items: sorted_records.slice(offset, offset + limit),
		total: sorted_records.length,
	};
}

function assert_valid_value(value: string): void {
	if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
		throw new Error("Environment values must fit on one line.");
	}
}

export async function update_item(id: string, value: string, project_root = process.cwd()): Promise<boolean> {
	assert_valid_value(value);

	const env_file = await read_env_file(project_root);
	const lines = split_lines(env_file.content);
	let updated = false;
	const updated_lines = lines.map((line) => {
		const match = line.match(ENV_ASSIGNMENT_PATTERN);
		if (!match || match[2] !== id) return line;
		updated = true;
		return `${match[1]!}${value}`;
	});

	if (!updated) return false;

	const line_ending = get_line_ending(env_file.content);
	await write_env_file(updated_lines.join(line_ending), project_root);
	return true;
}

export async function delete_items(ids: string[], project_root = process.cwd()): Promise<number> {
	const unique_ids = new Set(ids);
	if (unique_ids.size === 0) return 0;

	const env_file = await read_env_file(project_root);
	const lines = split_lines(env_file.content);
	const deleted_keys = new Set<string>();
	const retained_lines = lines.filter((line) => {
		const match = line.match(ENV_ASSIGNMENT_PATTERN);
		if (!match || !unique_ids.has(match[2]!)) return true;
		deleted_keys.add(match[2]!);
		return false;
	});

	if (deleted_keys.size === 0) return 0;

	const line_ending = get_line_ending(env_file.content);
	await write_env_file(retained_lines.join(line_ending), project_root);
	return deleted_keys.size;
}
