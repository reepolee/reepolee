/**
 * Dev-only GitHub issue reporter - POST /__issue
 *
 * Triggered by Ctrl+Shift+I in the browser (lib/issue_reporter_client.js, injected
 * only when is_dev - see lib/render.ts). Target repo comes from package.json's
 * "ree.issue_repo" (written by `bun reeman set-repo`), not the local git origin -
 * they can diverge (forks, renamed remotes). This is a reeman-specific field, kept
 * separate from the standard npm "repository"/"bugs" fields so the two can't be
 * confused. Shells out to the system `gh` CLI, which must already be authenticated
 * (`gh auth login`) - this app never handles a GitHub token itself.
 *
 * Screenshots (one or more, each with an optional label such as "Before"/"After")
 * are committed to the issue repo itself, on an orphan `screenshots` branch, via the
 * GitHub contents API - so they need no credentials beyond the `gh` login already
 * required above, and no third-party host. Clickable links use authenticated
 * `github.com/<repo>/blob/screenshots/...` URLs, while image sources use the matching
 * authenticated `github.com/<repo>/raw/screenshots/...` URLs. The blob URL returns an
 * HTML page and cannot be used as an image source.
 * (verified by hand on reepolee-dev#196). Screenshots filed before this used a
 * Cloudflare R2 bucket; those older issues still point at it and are left alone.
 */

import type { BunRequest } from "bun";
import { join } from "node:path";

import { uuid_v7 } from "$lib/uuid";
import { resolve_session } from "$platform/auth/middleware";

async function run_gh(args: string[], stdin?: string): Promise<{ ok: boolean; stdout: string; stderr: string; }> {
	const proc = Bun.spawn(["gh", ...args], {
		stdin: stdin !== undefined ? "pipe" : undefined,
		stdout: "pipe",
		stderr: "pipe",
	});

	if (stdin !== undefined && proc.stdin) {
		const writer = proc.stdin as import("bun").FileSink;
		await writer.write(stdin);
		await writer.end();
	}

	// Consume both pipes while the process is running. Waiting for `exited` first
	// can release Bun's stream readers before Response.text() consumes them.
	const stdout_promise = new Response(proc.stdout).text();
	const stderr_promise = new Response(proc.stderr).text();
	const [exit_code, stdout, stderr] = await Promise.all([proc.exited, stdout_promise, stderr_promise]);

	return { ok: exit_code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function get_current_repo(): Promise<string> {
	const pkg_path = join(process.cwd(), "package.json");
	const pkg = await Bun.file(pkg_path).json();
	const issue_repo = pkg?.ree?.issue_repo as string | undefined;

	if (!issue_repo) { throw new Error("package.json has no \"ree.issue_repo\" - run `bun reeman set-repo <owner/repo>` before filing issues"); }

	return issue_repo;
}

const AGENT_READY_LABEL = "agent ready";

async function ensure_agent_ready_label(repo: string): Promise<void> {
	const list_result = await run_gh(["label", "list", "--repo", repo, "--search", AGENT_READY_LABEL, "--json", "name", "-q", ".[].name"]);
	const exists = list_result.ok && list_result.stdout.split("\n").some((name) => name.trim() === AGENT_READY_LABEL);
	if (exists) return;

	await run_gh(["label", "create", AGENT_READY_LABEL, "--repo", repo, "--description", "Issue is ready to be worked on by an LLM agent", "--color", "0052cc"]);
}

const ASSETS_BRANCH = "screenshots";
const ASSETS_DIR = "github-assets";

// Screenshots live on an orphan branch, so they never enter main's history and
// never land in a normal checkout. Created lazily on first use - same pattern as
// ensure_agent_ready_label above.
//
// The branch is "screenshots", NOT "assets": git refs are a path namespace, and
// this repo already has refs/heads/assets/pr-161, so refs/heads/assets can never
// exist alongside it - GitHub rejects that with a 422 "Reference update failed".
//
// The strings below are GitHub API/URL paths, not filesystem paths, so they are
// built with template literals: path.join() would emit backslashes on Windows.
async function ensure_assets_branch(repo: string): Promise<{ ok: true; } | { error: string; }> {
	const ref_result = await run_gh(["api", `repos/${repo}/git/ref/heads/${ASSETS_BRANCH}`]);
	if (ref_result.ok) { return { ok: true }; }

	const readme = "Screenshots referenced from issue reports. Orphan branch - not part of the source tree.\n";
	const tree_payload = JSON.stringify({ tree: [{ path: "README.md", mode: "100644", type: "blob", content: readme }] });
	const tree_result = await run_gh(["api", `repos/${repo}/git/trees`, "--method", "POST", "--input", "-"], tree_payload);
	if (!tree_result.ok) { return { error: `Could not create assets tree: ${tree_result.stderr}` }; }

	const tree_json = JSON.parse(tree_result.stdout);
	const tree_sha = tree_json.sha as string;
	const commit_payload = JSON.stringify({ message: "Initialise issue screenshot assets branch", tree: tree_sha, parents: [] });
	const commit_result = await run_gh(["api", `repos/${repo}/git/commits`, "--method", "POST", "--input", "-"], commit_payload);
	if (!commit_result.ok) { return { error: `Could not create assets commit: ${commit_result.stderr}` }; }

	const commit_json = JSON.parse(commit_result.stdout);
	const commit_sha = commit_json.sha as string;
	const ref_payload = JSON.stringify({ ref: `refs/heads/${ASSETS_BRANCH}`, sha: commit_sha });
	const create_ref_result = await run_gh(["api", `repos/${repo}/git/refs`, "--method", "POST", "--input", "-"], ref_payload);
	if (!create_ref_result.ok) { return { error: `Could not create assets branch: ${create_ref_result.stderr}` }; }

	return { ok: true };
}

// The link must use the authenticated github.com/<repo>/blob/... host, NOT a raw
// content URL. GitHub can authorize blob assets from private repositories when the
// issue viewer is signed in; raw.githubusercontent.com cannot use that session.
export function screenshot_asset_url(repo: string, asset_path: string): string {
	return `https://github.com/${repo}/blob/${ASSETS_BRANCH}/${asset_path}`;
}

export function screenshot_asset_raw_url(repo: string, asset_path: string): string {
	return `https://github.com/${repo}/raw/${ASSETS_BRANCH}/${asset_path}`;
}

async function upload_screenshot(repo: string, screenshot: File): Promise<{ public_url: string; image_url: string; } | { error: string; }> {
	const branch_result = await ensure_assets_branch(repo);
	if ("error" in branch_result) { return branch_result; }

	const key = `${uuid_v7()}.png`;
	const asset_path = `${ASSETS_DIR}/${key}`;
	const bytes = await screenshot.arrayBuffer();
	const buffer = Buffer.from(bytes);
	const content = buffer.toString("base64");
	const payload = JSON.stringify({ message: `Add issue screenshot ${key}`, content, branch: ASSETS_BRANCH });

	const upload_result = await run_gh(["api", `repos/${repo}/contents/${asset_path}`, "--method", "PUT", "--input", "-"], payload);
	if (!upload_result.ok) { return { error: upload_result.stderr || upload_result.stdout || "unknown gh error" }; }

	return {
		public_url: screenshot_asset_url(repo, asset_path),
		image_url: screenshot_asset_raw_url(repo, asset_path),
	};
}

export async function handle_create_issue(req: Request): Promise<Response> {
	const form_data = await req.formData();

	const title = (form_data.get("title") as string)?.trim() || "";
	const description = (form_data.get("description") as string)?.trim() || "";
	const page_url = (form_data.get("page_url") as string)?.trim() || "";
	const labels = form_data.getAll("labels").map((label) => String(label)).filter(Boolean);
	const screenshot_files = (form_data.getAll("screenshot") as File[]).filter((file) => file.size > 0);
	const screenshot_labels = form_data.getAll("screenshot_label").map((label) => String(label).trim());

	if (!title) { return Response.json({ ok: false, error: "Title is required" }, { status: 400 }); }

	let repo: string;
	try {
		repo = await get_current_repo();
	} catch (err) {
		return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}

	let body = description;

	// Screenshot upload degrades: a failed upload must never block the report.
	// The issue is filed regardless, with a note naming what did not make it, so
	// the asset can be attached by hand afterwards.
	const image_lines: string[] = [];
	const upload_errors: string[] = [];
	let index = 0;
	for (const screenshot of screenshot_files) {
		const label = (screenshot_labels[index] || "Screenshot").replace(/[\[\]()\n\r]/g, " ");
		const upload_result = await upload_screenshot(repo, screenshot);
		if ("error" in upload_result) {
			upload_errors.push(`${label}: ${upload_result.error}`);
		} else {
			image_lines.push(`[![${label}](${upload_result.image_url})](${upload_result.public_url})`);
		}
		index += 1;
	}
	if (image_lines.length > 0) { body = `${image_lines.join("\n")}\n\n${body}`; }
	if (upload_errors.length > 0) {
		const error_list = upload_errors.map((line) => `- ${line}`).join("\n");
		body += `\n\n---\n**Screenshot upload failed - filed without the image(s):**\n\n${error_list}`;
	}

	const session = await resolve_session(req as BunRequest);
	// Issue #97: do not render \`@username\` - GitHub turns it into a mention.
	// Bold the user's email instead (fall back to username when there is none).
	const current_user = session.current_user;
	const filed_by = current_user ? (current_user.email || current_user.username) : "";
	body += filed_by ? `\n\n---\n_Filed via bun dev issue reporter by **${filed_by}**_` : "\n\n---\n_Filed via bun dev issue reporter_";

	// Issue #11: include the page URL the issue was filed from, at the end of the report.
	if (page_url) { body += `\n\nReported from: ${page_url}`; }

	const all_labels = labels.includes(AGENT_READY_LABEL) ? labels : [...labels, AGENT_READY_LABEL];
	await ensure_agent_ready_label(repo);

	const issue_args = ["issue", "create", "--repo", repo, "--title", title, "--body-file", "-"];
	for (const label of all_labels) { issue_args.push("--label", label); }

	const issue_result = await run_gh(issue_args, body);

	if (!issue_result.ok) { return Response.json({ ok: false, error: issue_result.stderr || issue_result.stdout || "Failed to create issue" }, { status: 500 }); }

	return Response.json({ ok: true, url: issue_result.stdout, screenshot_errors: upload_errors });
}
