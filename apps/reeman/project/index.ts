import { navigation } from "./config";
import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { set_repos } from "$generator/reeman/set_repo";
import { list_issue_repos } from "$lib/issue_reporter";

const BASE_PATH = "/project";
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** The configured issue-report repositories, in issue-reporter order. */
async function read_current_repos(): Promise<string[]> {
	try {
		return await list_issue_repos();
	} catch {
		return [];
	}
}

export async function get_project_page(req: BunRequest, form_error = ""): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const current_repos = await read_current_repos();

	return render("index", {
		data: { page_title: ctx.translations.ui?.project_title, current_repos, form_error },
		ctx,
	});
}

export async function post_set_repos(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const owner_repos = (params.get("owner_repos") ?? "").split("\n").map((repo) => repo.trim()).filter(Boolean);

	if (owner_repos.length === 0 || owner_repos.some((repo) => !OWNER_REPO_RE.test(repo))) {
		return get_project_page(req, "Each repository must use the owner/repo format");
	}

	if (new Set(owner_repos).size !== owner_repos.length) {
		return get_project_page(req, "Each repository can appear only once");
	}

	await set_repos(owner_repos);

	return Response.redirect(localized_url(BASE_PATH, resolve_locale(req)), 303);
}

export const project_crud = {
	"/project": { GET: get_project_page },
	"/project/set-repos": { POST: post_set_repos },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/project",
		crud: project_crud,
		nav_title_key: "reeman.project",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
