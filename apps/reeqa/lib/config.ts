import { join, resolve } from "node:path";

export type Qa_suite = {
	code: string;
	name: string;
	description: string;
	required_script?: string;
	command: readonly string[];
};

export const qa_project_root = resolve(import.meta.dir, "../../..");
export const qa_config_dir = join(qa_project_root, ".reepolee", "reeqa");
const agent_port = Bun.env.AGENT_REEQA_SERVER_PORT;
export const qa_runtime_dir = agent_port
	? join(qa_project_root, ".reepolee", `reeqa-agent-${agent_port}`)
	: qa_config_dir;

// Visual baselines are captured in a headless browser sized per page set, so
// mobile and desktop pages can be captured at their natural widths. Capture
// and compare use the same size so they render identically (site scrollbar
// gutters included).
export type Visual_capture_preset = { id: string; label: string; width: number; height: number; };

export const visual_capture_presets: readonly Visual_capture_preset[] = [
	{ id: "mobile", label: "Mobile", width: 390, height: 844 },
	{ id: "tablet", label: "Tablet", width: 768, height: 1024 },
	{ id: "desktop", label: "Desktop", width: 1920, height: 1080 },
];

export function resolve_capture_preset(preset_id: string | null | undefined): Visual_capture_preset | undefined {
	return visual_capture_presets.find((preset) => preset.id === preset_id);
}

// Desktop is the default capture size (the most common desktop resolution).
export const visual_capture_width = 1920;
export const visual_capture_height = 1080;

export const qa_suites: readonly Qa_suite[] = [
	{
		code: "tests",
		name: "Website tests",
		description: "Run the Bun test suite in the website project.",
		command: ["bun", "test"],
	},
	{
		code: "engine-drift",
		name: "Engine drift",
		description: "Check the website template engine against the canonical Reepolee copy.",
		required_script: "engine:check",
		command: ["bun", "run", "engine:check"],
	},
	{
		code: "naming",
		name: "Naming compliance",
		description: "Check server and client filenames against Reepolee naming rules.",
		required_script: "naming:check",
		command: ["bun", "run", "naming:check"],
	},
	{
		code: "docs-links",
		name: "Documentation links",
		description: "Check internal documentation links and anchors.",
		required_script: "docs:check",
		command: ["bun", "run", "docs:check"],
	},
];

export function get_qa_suite(code: string): Qa_suite | undefined {
	return qa_suites.find((suite) => suite.code === code);
}
