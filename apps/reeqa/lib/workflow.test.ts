import { describe, expect, test } from "bun:test";

import { checkpoint_replay_steps, click_target_expression, parse_workflow_steps, resolve_fill_value, scroll_to_center_target, step_annotation, step_label, workflow_step_scripts, type Workflow_step } from "./workflow";

const { click_script, fill_script, element_rect_script, element_text_script } = workflow_step_scripts;

describe("parse_workflow_steps", () => {
	test("parses a valid workflow", () => {
		const steps = parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com/login" },
			{ type: "fill", selector: "#username", value_env: "ADMIN_USERNAME" },
			{ type: "fill", selector: "#password", value_env: "ADMIN_PASSWORD" },
			{ type: "click", selector: "button[type=submit]", checkpoint: true },
		]));
		expect(steps).toEqual([
			{ type: "navigate", url: "https://example.com/login" },
			{ type: "fill", selector: "#username", value_env: "ADMIN_USERNAME" },
			{ type: "fill", selector: "#password", value_env: "ADMIN_PASSWORD" },
			{ type: "click", selector: "button[type=submit]", checkpoint: true },
		]);
	});

	test("rejects empty input", () => {
		expect(() => parse_workflow_steps("")).toThrow("Workflow steps are required");
	});

	test("rejects invalid JSON", () => {
		expect(() => parse_workflow_steps("{not json")).toThrow("not valid JSON");
	});

	test("rejects a non-array", () => {
		expect(() => parse_workflow_steps(JSON.stringify({ type: "navigate", url: "https://example.com" }))).toThrow("must be a JSON array");
	});

	test("rejects an empty array", () => {
		expect(() => parse_workflow_steps("[]")).toThrow("Add at least one workflow step");
	});

	test("rejects an unknown step type", () => {
		expect(() => parse_workflow_steps(JSON.stringify([{ type: "hover", selector: "a" }]))).toThrow("unknown type");
	});

	test("rejects an unknown field", () => {
		expect(() => parse_workflow_steps(JSON.stringify([{ type: "navigate", url: "https://example.com", chekpoint: true }]))).toThrow("unknown field: chekpoint");
	});

	test("rejects a fill step with both value and value_env", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "fill", selector: "#x", value: "a", value_env: "B", checkpoint: true },
		]))).toThrow("set value or value_env, not both");
	});

	test("rejects a workflow whose first step is not navigate", () => {
		expect(() => parse_workflow_steps(JSON.stringify([{ type: "click", selector: "a", checkpoint: true }]))).toThrow("first workflow step must be a navigate step");
	});

	test("rejects a workflow with no checkpoint", () => {
		expect(() => parse_workflow_steps(JSON.stringify([{ type: "navigate", url: "https://example.com" }]))).toThrow("Mark at least one step as a checkpoint");
	});

	test("parses a click by visible text", () => {
		const steps = parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", checkpoint: true },
		]));
		expect(steps[1]).toEqual({ type: "click", text: "Approach", checkpoint: true });
	});

	test("rejects a click with both selector and text", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", selector: "a", text: "Approach", checkpoint: true },
		]))).toThrow("exactly one of selector or text");
	});

	test("rejects a click with neither selector nor text", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", checkpoint: true },
		]))).toThrow("exactly one of selector or text");
	});

	test("parses a non-negative delay_seconds on any step", () => {
		const steps = parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com", delay_seconds: 3 },
			{ type: "click", text: "Approach", delay_seconds: 3, checkpoint: true },
		]));
		expect(steps[0]).toEqual({ type: "navigate", url: "https://example.com/", delay_seconds: 3 });
		expect(steps[1]).toEqual({ type: "click", text: "Approach", delay_seconds: 3, checkpoint: true });
	});

	test("rejects a negative or non-numeric delay_seconds", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", delay_seconds: -1, checkpoint: true },
		]))).toThrow("delay_seconds must be a non-negative number");
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", delay_seconds: "3", checkpoint: true },
		]))).toThrow("delay_seconds must be a non-negative number");
	});

	test("parses before_seconds on any step", () => {
		const steps = parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com", before_seconds: 1 },
			{ type: "click", text: "Approach", before_seconds: 0.5, checkpoint: true },
		]));
		expect(steps[0]).toEqual({ type: "navigate", url: "https://example.com/", before_seconds: 1 });
		expect(steps[1]).toEqual({ type: "click", text: "Approach", before_seconds: 0.5, checkpoint: true });
	});

	test("rejects a negative or non-numeric before_seconds", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", before_seconds: -1, checkpoint: true },
		]))).toThrow("before_seconds must be a non-negative number");
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", before_seconds: "1", checkpoint: true },
		]))).toThrow("before_seconds must be a non-negative number");
	});

	test("parses outline_seconds and glide_seconds on a click step", () => {
		const steps = parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", outline_seconds: 0.5, glide_seconds: 0.8, checkpoint: true },
		]));
		expect(steps[1]).toEqual({ type: "click", text: "Approach", outline_seconds: 0.5, glide_seconds: 0.8, checkpoint: true });
	});

	test("rejects a negative or non-numeric outline_seconds / glide_seconds", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", outline_seconds: -1, checkpoint: true },
		]))).toThrow("outline_seconds must be a non-negative number");
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com" },
			{ type: "click", text: "Approach", glide_seconds: "1.6", checkpoint: true },
		]))).toThrow("glide_seconds must be a non-negative number");
	});

	test("rejects outline_seconds / glide_seconds on a non-click step", () => {
		expect(() => parse_workflow_steps(JSON.stringify([
			{ type: "navigate", url: "https://example.com", outline_seconds: 1 },
		]))).toThrow("unknown field: outline_seconds");
	});
});

describe("resolve_fill_value", () => {
	test("returns the literal value when set", () => {
		const step: Workflow_step & { type: "fill" } = { type: "fill", selector: "#x", value: "hello" };
		expect(resolve_fill_value(step, {})).toBe("hello");
	});

	test("falls back to empty string with neither value nor value_env", () => {
		const step: Workflow_step & { type: "fill" } = { type: "fill", selector: "#x" };
		expect(resolve_fill_value(step, {})).toBe("");
	});

	test("resolves value_env from the env map", () => {
		const step: Workflow_step & { type: "fill" } = { type: "fill", selector: "#x", value_env: "ADMIN_PASSWORD" };
		expect(resolve_fill_value(step, { ADMIN_PASSWORD: "secret" })).toBe("secret");
	});

	test("throws (naming only the variable) when value_env is missing", () => {
		const step: Workflow_step & { type: "fill" } = { type: "fill", selector: "#x", value_env: "ADMIN_PASSWORD" };
		expect(() => resolve_fill_value(step, {})).toThrow("ADMIN_PASSWORD is not set");
	});
});

describe("step_label", () => {
	test("never includes a literal fill value", () => {
		const label = step_label({ type: "fill", selector: "#password", value: "super-secret" });
		expect(label).not.toContain("super-secret");
	});

	test("names the env var, not the resolved value, for value_env fills", () => {
		expect(step_label({ type: "fill", selector: "#password", value_env: "ADMIN_PASSWORD" })).toBe("fill #password from ADMIN_PASSWORD");
	});

	test("labels a click by its selector or text", () => {
		expect(step_label({ type: "click", selector: "a.nav" })).toBe("click a.nav");
		expect(step_label({ type: "click", text: "Approach" })).toBe("click Approach");
	});
});

describe("step_annotation", () => {
	test("labels each supported action with a readable verb phrase", () => {
		expect(step_annotation({ type: "navigate", url: "https://example.com/" })).toBe("Open https://example.com/");
		expect(step_annotation({ type: "click", text: "Approach" })).toBe('Click "Approach"');
		expect(step_annotation({ type: "click", selector: "a.nav" })).toBe("Click a.nav");
		expect(step_annotation({ type: "fill", selector: "#username" })).toBe("Fill #username");
	});

	test("never exposes a literal or env-resolved fill value", () => {
		expect(step_annotation({ type: "fill", selector: "#password", value: "super-secret" })).toBe("Fill #password");
		expect(step_annotation({ type: "fill", selector: "#password", value_env: "ADMIN_PASSWORD" })).toBe("Fill #password");
	});
});

describe("checkpoint_replay_steps", () => {
	const steps: Workflow_step[] = [
		{ type: "navigate", url: "https://example.com/login" },
		{ type: "fill", selector: "#username", value_env: "ADMIN_USERNAME" },
		{ type: "fill", selector: "#password", value_env: "ADMIN_PASSWORD" },
		{ type: "click", selector: "button[type=submit]", checkpoint: true },
		{ type: "navigate", url: "https://example.com/dashboard", checkpoint: true },
	];

	test("replays every step from the first through the checkpoint's own step", () => {
		expect(checkpoint_replay_steps(steps, 3)).toEqual(steps.slice(0, 4));
	});

	test("a later checkpoint includes the earlier login steps too", () => {
		expect(checkpoint_replay_steps(steps, 4)).toEqual(steps);
	});

	test("a checkpoint on the first step replays just that step", () => {
		expect(checkpoint_replay_steps(steps, 0)).toEqual([steps[0]!]);
	});

	test("rejects an out-of-range step index", () => {
		expect(() => checkpoint_replay_steps(steps, 5)).toThrow("outside the recorded 5 step(s)");
		expect(() => checkpoint_replay_steps(steps, -1)).toThrow("outside the recorded 5 step(s)");
		expect(() => checkpoint_replay_steps(steps, 1.5)).toThrow("outside the recorded 5 step(s)");
	});
});

describe("scroll_to_center_target", () => {
	test("centers a target below the fold and leaves an above-the-fold target alone", () => {
		expect(scroll_to_center_target({ top: 100, height: 40, scroll_y: 0, inner_height: 800, document_height: 2000 })).toBe(0);
		expect(scroll_to_center_target({ top: 900, height: 40, scroll_y: 0, inner_height: 800, document_height: 2000 })).toBe(520);
	});

	test("clamps to the document's maximum scroll position", () => {
		expect(scroll_to_center_target({ top: 900, height: 40, scroll_y: 0, inner_height: 800, document_height: 1000 })).toBe(200);
	});
});

describe("injection safety", () => {
	const hostile = `'; alert(1); //\n</script>`;

	test("click_script embeds the selector only through JSON.stringify", () => {
		const script = click_script({ selector: hostile });
		expect(script).toContain(JSON.stringify(hostile));
	});

	test("click_script embeds text targets only through JSON.stringify", () => {
		const script = click_script({ text: hostile });
		expect(script).toContain(JSON.stringify(hostile));
	});

	test("click_target_expression uses a selector verbatim for selector targets", () => {
		expect(click_target_expression({ selector: "a.nav" })).toBe("document.querySelector(\"a.nav\")");
	});

	test("element_rect_script returns the element's viewport rect and scroll metrics without scrolling", () => {
		const script = element_rect_script({ text: "Approach" });
		expect(script).toContain("getBoundingClientRect");
		expect(script).toContain("rect.left + rect.width / 2");
		expect(script).toContain("window.scrollY");
		expect(script).toContain("scrollHeight");
		expect(script).not.toContain("scrollIntoView");
	});

	test("element_text_script resolves the target's visible text without scrolling", () => {
		const script = element_text_script({ selector: "a.nav" });
		expect(script).toContain("textContent");
		expect(script).toContain("replace(/\\s+/g");
		expect(script).toContain("slice(0, 80)");
		expect(script).not.toContain("scrollIntoView");
	});

	test("element_text_script embeds selectors only through JSON.stringify", () => {
		const script = element_text_script({ selector: hostile });
		expect(script).toContain(JSON.stringify(hostile));
	});

	test("fill_script embeds the selector and value only through JSON.stringify", () => {
		const script = fill_script(hostile, hostile);
		expect(script.split(JSON.stringify(hostile)).length - 1).toBe(2);
	});
});
