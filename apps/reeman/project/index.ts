import { localized_url, resolve_locale } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { set_repo } from "$generator/reeman/set_repo";

const BASE_PATH = "/project";
const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

async function read_current_repo(): Promise<string> {
	const pkg = await Bun.file("package.json").json();
	return (pkg?.ree?.issue_repo as string | undefined) ?? "";
}

export async function get_project_page(req: BunRequest, form_error = ""): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const current_repo = await read_current_repo();

	return render("index", {
		data: { current_repo, form_error },
		ctx,
	});
}

export async function post_set_repo(req: BunRequest): Promise<Response> {
	const body = await req.text();
	const params = new URLSearchParams(body);
	const owner_repo = (params.get("owner_repo") ?? "").trim();

	if (!owner_repo || !OWNER_REPO_RE.test(owner_repo)) {
		return get_project_page(req, "Invalid format - expected owner/repo");
	}

	await set_repo(owner_repo);

	return Response.redirect(localized_url(BASE_PATH, resolve_locale(req)), 303);
}

export const project_crud = {
	"/project": { GET: get_project_page },
	"/project/set-repo": { POST: post_set_repo },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/project",
		crud: project_crud,
		nav_title_key: "reeman.project",
		module: "system",
		nav_module: null,
	},
];
