import { create_toast_cookie } from "$lib/cookies";
import { get_locale_from_request, localized_url } from "$lib/route";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

// AGENT NOTE: This nested module demonstrates the generated CRUD edit-route
// shape for a non-table record. It deliberately reuses the list module's data
// and keeps the save operation fake.
import { get_index_template_record, owners } from "../index";

// Keep this in sync with the list route and its template links.
const BASE_PATH = "/examples/index-template";

// ROUTE RESOURCE: registered separately from the list so this detail page is
// not shown as another sidebar menu entry.
export const record_details_page = {
	"/examples/index-template/:id/record-details": { GET: get_record_details, POST: post_record_details },
};

// GET /examples/index-template/:id/record-details
// Replace get_index_template_record with a real service/API lookup when the
// example becomes a production detail page.
export async function get_record_details(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// Route params are strings; this example uses numeric IDs. Adapt parsing if
	// the external source uses UUIDs or another key format.
	const id = Number(req.params.id || 0);
	const record = get_index_template_record(id);

	if (!record) {
		return render("notfound", {
			data: { title: "404 Not Found" },
			status: 404,
			ctx,
		});
	}

	// Nested route templates resolve `render("index")` to this directory's
	// record_details/index.ree. Do not rename this to record_details unless the
	// template file is renamed to record_details.ree as well.
	return render("index", {
		data: {
			title: `Edit ${record.path}`,
			record,
			owners,
			action: `${BASE_PATH}/${record.id}/record-details`,
		},
		ctx,
	});
}

// POST /examples/index-template/:id/record-details
// This is intentionally a fake save: it consumes submitted form data, emits a
// toast, and redirects to the list without changing the in-memory array.
export async function post_record_details(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// Keep the same lookup/404 behavior as GET before accepting the fake save.
	const id = Number(req.params.id || 0);
	const record = get_index_template_record(id);

	if (!record) {
		return render("notfound", {
			data: { title: "404 Not Found" },
			status: 404,
			ctx,
		});
	}

	// Demo only: accept the form, but deliberately do not mutate the array.
	// AGENT EXTENSION POINT: Parse/validate fields here, call the real write API,
	// then keep the toast + redirect pattern below for the post/redirect/get flow.
	await req.text();
	const locale = get_locale_from_request(req) || "en-us";
	// The toast is stored in a cookie so it survives the redirect and is rendered
	// by the shared layout on the destination list page.
	const cookie = create_toast_cookie({
		record_id: record.id,
		feature: "index_template",
		message: "Demo record saved.",
		type: "green",
		user: ctx.user?.display_name,
	});
	// Save goes back to the list by design. Change BASE_PATH here if the real
	// workflow should return to the detail page or preserve list query params.
	const headers = new Headers({ Location: localized_url(BASE_PATH, locale) });
	headers.append("Set-Cookie", cookie.toString());
	return new Response(null, { status: 303, headers });
}
