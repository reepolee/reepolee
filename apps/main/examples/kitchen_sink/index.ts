import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import type { BunRequest } from "bun";

import { validate_touched } from "./schema/validation_server";

export const kitchen_sink_page = {
	"/examples/kitchen-sink": { GET: get_kitchen_sink },
	"/examples/kitchen-sink/validate": { POST: post_kitchen_sink_validate },
};

export async function get_kitchen_sink(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	return render("kitchen_sink", { ctx });
}

export async function post_kitchen_sink_validate(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body: any = await req.json();
	const touched: string[] = body.touched || [];

	const data = { text_input: body.text_input || "", email_input: body.email_input || "" };

	const [errors] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}
