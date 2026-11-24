import { navigation } from "./config";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { post_backup_database, post_check_compliance, post_data_to_sql, post_inspect_import, post_run_sql } from "../reeman/handlers";
import { load_reeman_data, type PageOverrides } from "../reeman/page";
import { is_studio_editable_path, studio_url } from "./lib/sql_files";

// Studio is a paid addon and may not be installed; only offer the "open in
// Studio" link when its route folder is actually present on disk.
const studio_installed = existsSync(join(import.meta.dir, "..", "studio", "index.ts"));

const DEFAULT_LIMIT = 20;
const BASE_PATH = "/database";
const SORT_OPTIONS = [
	{ value: "folder::asc", field: "folder", direction: "asc" },
	{ value: "folder::desc", field: "folder", direction: "desc" },
	{ value: "name::asc", field: "name", direction: "asc" },
	{ value: "name::desc", field: "name", direction: "desc" },
] as const;

export async function get_database_page(req: BunRequest, overrides: PageOverrides = {}): Promise<Response> {
	const [data, ctx] = await Promise.all([
		load_reeman_data({ sql_files: true }),
		create_ctx(req, import.meta.dir),
	]);
	const { query, offset, limit, order_by } = parse_pagination_params(req.url, DEFAULT_LIMIT);
	const normalized_limit = limit === "all" ? "all" : Math.max(1, limit);
	const normalized_query = query.trim().toLowerCase();
	const sort_option = SORT_OPTIONS.find((option) => option.value === order_by) || SORT_OPTIONS[0];
	const filtered_files = [...data.sql_files]
		.filter((file) => !normalized_query || file.folder.toLowerCase().includes(normalized_query) || file.name.toLowerCase().includes(normalized_query))
		.sort((left, right) => {
			const left_value = sort_option.field === "folder" ? left.folder : left.name;
			const right_value = sort_option.field === "folder" ? right.folder : right.name;
			return sort_option.direction === "asc" ? left_value.localeCompare(right_value) : right_value.localeCompare(left_value);
		});
	const total = filtered_files.length;
	const limit_numeric = normalized_limit === "all" ? Math.max(total, 1) : get_limit_numeric(normalized_limit);
	const paged_files = normalized_limit === "all" ? filtered_files : filtered_files.slice(offset, offset + limit_numeric);
	const folder_counts = new Map<string, number>();
	for (const file of paged_files) folder_counts.set(file.folder, (folder_counts.get(file.folder) ?? 0) + 1);
	const page_files = paged_files.map((file, index) => {
		const next_folder = index === paged_files.length - 1 ? null : paged_files[index + 1]?.folder;
		return {
			path: file.path,
			folder: file.folder,
			name: file.name,
			last_updated: file.last_updated,
			can_open_in_studio: studio_installed && is_studio_editable_path(file.path),
			studio_url: studio_url(file.path),
			// Folders are only contiguous on the page when sorted by folder; the
			// summary footer only makes sense in that case.
			show_folder_summary: sort_option.field === "folder" && next_folder !== file.folder,
			folder_count: folder_counts.get(file.folder) ?? 0,
		};
	});
	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(
		BASE_PATH,
		offset,
		limit_numeric,
		total,
		query,
		sort_option.value,
	);

	// Use the cloned index-template view. The original database/index.ree remains
	// separate as the historical fallback/template reference.
	return render("index_template", {
		data: {
			page_title: ctx.translations.ui?.database_title,
			sql_files: page_files,
			busy: data.busy,
			broken_views: data.broken_views,
			form_error: overrides.form_error ?? "",
			query,
			limit: normalized_limit,
			offset,
			total,
			limit_options: get_limit_options(normalized_limit),
			sort_options: SORT_OPTIONS,
			order_by: sort_option.value,
			prev_url,
			next_url,
			first_url,
			last_url,
		},
		ctx,
		status: overrides.status ?? 200,
	});
}

export const database_crud = {
	"/database": { GET: get_database_page },
	"/run-sql": { POST: post_run_sql },
	"/backup-database": { POST: post_backup_database },
	"/data-to-sql": { POST: post_data_to_sql },
	"/inspect-import": { POST: post_inspect_import },
	"/check-compliance": { POST: post_check_compliance },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/database",
		crud: database_crud,
		nav_title_key: "reeman.database",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
