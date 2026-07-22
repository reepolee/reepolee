export async function post___table.exact___validate(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.json();
	const touched: string[] = body.touched || [];

	const data = {
		__validate.params__
	};

	const [errors,valid_data] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}
