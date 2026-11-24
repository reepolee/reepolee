#!/usr/bin/env bun

import { run_selected_nested_children, type NestedChildSelection } from "$generator/reeman/callers/resource_caller";

type RunnerPayload = {
	parent_table: string;
	prefix: string;
	children: NestedChildSelection[];
	pagination: "cursor" | "offset";
	render_strategy: "stream" | "load";
	template_tags: "flat" | "tags";
	translate: boolean;
};

const raw_payload = Bun.argv[2];
if (!raw_payload) throw new Error("Nested children runner requires a payload.");
const payload = JSON.parse(raw_payload) as RunnerPayload;
const valid_pagination = payload.pagination === "cursor" || payload.pagination === "offset";
const valid_render_strategy = payload.render_strategy === "stream" || payload.render_strategy === "load";
const valid_template_tags = payload.template_tags === "flat" || payload.template_tags === "tags";
const valid_children = Array.isArray(payload.children) && payload.children.length > 0 && payload.children.every((child) => child.table && child.fk_column);
if (!payload.parent_table || !valid_pagination || !valid_render_strategy || !valid_template_tags || !valid_children) throw new Error("Nested children runner received an invalid payload.");

const result = await run_selected_nested_children(
	payload.children,
	payload.parent_table,
	payload.prefix,
	payload.pagination,
	payload.render_strategy,
	payload.translate,
	payload.template_tags,
);
console.log(`Nested children complete: ${result.success}/${payload.children.length} generated.`);
process.exit(result.fail === 0 ? 0 : 1);
