/** Interactive flow for generating a synthetic, non-DB BREAD resource. */

import { create_bread, create_localized_bread } from "../../crud/create_bread";
import type { ColumnDef, SyntheticSchema } from "../../schema/types";
import { ask, BOLD, color, confirm, CYAN, dim, GREEN, header, RED, YELLOW } from "../ui";

function is_valid_identifier(value: string): boolean {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

export async function run_create_bread_flow(): Promise<boolean> {
	header("Fake-table resource (BREAD)");
	console.log(`  ${dim("Creates normal CRUD files from a schema without creating or inspecting a database table.")}`);
	console.log(`  ${dim("Afterward, implement the generated store.ts stub with the resource's own reader and writer.")}`);

	const table_name = await ask("Resource name");
	if (!is_valid_identifier(table_name)) {
		console.log(`  ${color("Use a valid table-style name (letters, numbers, underscores).", RED)}`);
		return false;
	}

	const columns: ColumnDef[] = [{
		name: "id",
		type_string: "INTEGER",
		comment: "",
		is_nullable: false,
		is_primary_key: true,
		is_auto_increment: true,
		is_generated: false,
	}];

	while (true) {
		const column_name = await ask("Column name (blank to finish)");
		if (!column_name) break;
		if (!is_valid_identifier(column_name) || column_name === "id") {
			console.log(`  ${color("Use a unique table-style name other than id.", RED)}`);
			continue;
		}
		if (columns.some((column) => column.name === column_name)) {
			console.log(`  ${color(`Column \"${column_name}\" already exists.`, RED)}`);
			continue;
		}

		const type_string = await ask(`SQL type for ${column_name}`, "VARCHAR(255)");
		const is_nullable = await confirm(`Allow ${column_name} to be empty?`, "n");
		columns.push({
			name: column_name,
			type_string,
			comment: "",
			is_nullable,
			is_primary_key: false,
			is_auto_increment: false,
			is_generated: false,
		});
	}

	if (columns.length === 1) {
		console.log(`  ${color("Add at least one resource column besides id.", RED)}`);
		return false;
	}

	const schema: SyntheticSchema = {
		type: "table",
		name: table_name,
		columns,
		foreign_keys: [],
		has_view: false,
	};
	console.log(`  ${color("✓", GREEN)} Schema: ${color(BOLD + columns.map((column) => column.name).join(", "), CYAN)}`);

	const localized = await confirm("Will this resource's store hold content per locale?", "n");
	const force = await confirm("Overwrite existing generated files without prompting?", "n");
	const proceed = await confirm("Generate the BREAD resource now?", "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return false;
	}

	const generator = localized ? create_localized_bread : create_bread;
	return await generator(schema, { force, interactive: true });
}
