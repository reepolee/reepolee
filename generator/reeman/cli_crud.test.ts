import { expect, test } from "bun:test";

import { parse_crud_flags } from "./cli_crud";

test("preserves explicit localized false through CRUD CLI arguments", () => {
	const definitions = encodeURIComponent(JSON.stringify([
		{
			name: "email",
			width: "auto",
			class_name: "",
			filter: false,
			localized: false,
			readonly: false,
			form: true,
		},
	]));

	const flags = parse_crud_flags(["users", "--grid-column-definitions", definitions]);

	expect(flags.grid_column_definitions).toEqual([{
		name: "email",
		width: "auto",
		class_name: "",
		filter: false,
		localized: false,
		readonly: false,
		form: true,
	}]);
});
