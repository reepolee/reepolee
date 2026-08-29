export async function get___table.exact___options(req: BunRequest): Promise<Response>
{
	const url = new URL(req.url);
	const q = url.searchParams.get("q") || "";
	const fk_table = url.searchParams.get("fk_table") || "";

	const results: { option_value: number | string; option_text: string }[] = [];

	__autocomplete.dispatch__

	return Response.json({ results });
}
