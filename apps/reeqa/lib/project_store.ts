import { existsSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { qa_config_dir, qa_suites, type Qa_suite } from "./config";

export type Qa_project = {
	id: string;
	name: string;
	path: string;
	base_url: string;
	created_at: string;
	visual_max_pages?: number;
};

export type Qa_project_suite = Qa_suite & {
	available: boolean;
};

type Package_manifest = {
	scripts?: Record<string, string>;
};

const projects_path = join(qa_config_dir, "projects.json");
const active_project_path = join(qa_config_dir, "active-project.json");

function is_active_project_store(value: unknown): value is { project_id: string; } {
	if (!value || typeof value !== "object") return false;
	const store = value as Record<string, unknown>;
	return typeof store.project_id === "string" && store.project_id.length > 0;
}

async function read_active_project_id(): Promise<string | undefined> {
	const file = Bun.file(active_project_path);
	const exists = await file.exists();
	if (!exists) return undefined;
	const value = await file.json() as unknown;
	if (!is_active_project_store(value)) return undefined;
	return value.project_id;
}

async function clear_active_project_id(): Promise<void> {
	if (existsSync(active_project_path)) rmSync(active_project_path);
}

function is_qa_project(value: unknown): value is Qa_project {
	if (!value || typeof value !== "object") return false;
	const project = value as Record<string, unknown>;
	return typeof project.id === "string"
		&& typeof project.name === "string"
		&& typeof project.path === "string"
		&& typeof project.base_url === "string"
		&& typeof project.created_at === "string"
		&& (project.visual_max_pages === undefined
			|| (typeof project.visual_max_pages === "number" && Number.isInteger(project.visual_max_pages) && project.visual_max_pages >= 1 && project.visual_max_pages <= 1000));
}

async function persist_projects(projects: Qa_project[]): Promise<void> {
	mkdirSync(qa_config_dir, { recursive: true });
	const body = `${JSON.stringify(projects, null, "\t")}\n`;
	await Bun.write(projects_path, body);
}

async function load_projects(): Promise<Qa_project[]> {
	const projects_file = Bun.file(projects_path);
	const exists = await projects_file.exists();
	if (!exists) {
		const projects: Qa_project[] = [];
		await persist_projects(projects);
		return projects;
	}

	const saved_projects = await projects_file.json() as unknown;
	if (!Array.isArray(saved_projects) || !saved_projects.every(is_qa_project)) {
		throw new Error(`Invalid ReeQA project store: ${projects_path}`);
	}
	return saved_projects;
}

async function read_manifest(project_path: string): Promise<Package_manifest> {
	const manifest_path = join(project_path, "package.json");
	const manifest_file = Bun.file(manifest_path);
	const exists = await manifest_file.exists();
	if (!exists) throw new Error("Project path must contain package.json.");
	const manifest = await manifest_file.json() as unknown;
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error("Project package.json must contain an object.");
	}
	return manifest as Package_manifest;
}

async function project_is_available(project: Qa_project): Promise<boolean> {
	try {
		await read_manifest(project.path);
		return true;
	} catch {
		return false;
	}
}

export async function list_projects(): Promise<Qa_project[]> {
	return load_projects();
}

export async function find_project(project_id: string): Promise<Qa_project | undefined> {
	const projects = await load_projects();
	return projects.find((project) => project.id === project_id);
}

function normalize_project_input(name_value: string, path_value: string, base_url_value: string): { name: string; path: string; base_url: string; } {
	const name = name_value.trim();
	const raw_path = path_value.trim();
	const raw_base_url = base_url_value.trim();
	if (!name) throw new Error("Project name is required.");
	if (name.length > 80) throw new Error("Project name must be at most 80 characters.");
	if (!raw_path) throw new Error("Project path is required.");
	if (!isAbsolute(raw_path)) throw new Error("Project path must be absolute.");
	if (!raw_base_url) throw new Error("Project URL is required.");
	const parsed_base_url = new URL(raw_base_url);
	if (parsed_base_url.protocol !== "http:" && parsed_base_url.protocol !== "https:") {
		throw new Error("Project URL must use HTTP or HTTPS.");
	}
	parsed_base_url.pathname = "/";
	parsed_base_url.search = "";
	parsed_base_url.hash = "";

	return {
		name,
		path: resolve(raw_path),
		base_url: parsed_base_url.href.slice(0, -1),
	};
}

export async function create_project(name_value: string, path_value: string, base_url_value: string): Promise<Qa_project> {
	const { name, path: project_path, base_url } = normalize_project_input(name_value, path_value, base_url_value);
	await read_manifest(project_path);
	const projects = await load_projects();
	if (projects.some((project) => project.path === project_path)) {
		throw new Error("That project path is already registered.");
	}

	const project: Qa_project = {
		id: crypto.randomUUID(),
		name,
		path: project_path,
		base_url,
		created_at: new Date().toISOString(),
	};
	projects.push(project);
	await persist_projects(projects);
	return project;
}

export async function update_project(project_id: string, name_value: string, path_value: string, base_url_value: string): Promise<Qa_project> {
	const { name, path: project_path, base_url } = normalize_project_input(name_value, path_value, base_url_value);
	await read_manifest(project_path);
	const projects = await load_projects();
	const project_index = projects.findIndex((project) => project.id === project_id);
	if (project_index < 0) throw new Error("QA project not found.");
	if (projects.some((project) => project.path === project_path && project.id !== project_id)) {
		throw new Error("That project path is already registered.");
	}

	const updated_project: Qa_project = {
		...projects[project_index]!,
		name,
		path: project_path,
		base_url,
	};
	projects[project_index] = updated_project;
	await persist_projects(projects);
	return updated_project;
}

function duplicate_project_name(projects: Qa_project[], source_name: string): string {
	let copy_number = 1;
	let duplicate_name = `${source_name} copy`;
	while (projects.some((project) => project.name === duplicate_name)) {
		copy_number += 1;
		duplicate_name = `${source_name} copy ${copy_number}`;
	}
	return duplicate_name;
}

export async function duplicate_project(project_id: string): Promise<Qa_project> {
	const projects = await load_projects();
	const source_project = projects.find((project) => project.id === project_id);
	if (!source_project) throw new Error("QA project not found.");
	const project: Qa_project = {
		...source_project,
		id: crypto.randomUUID(),
		name: duplicate_project_name(projects, source_project.name),
		created_at: new Date().toISOString(),
	};
	projects.push(project);
	await persist_projects(projects);
	return project;
}

export async function delete_project(project_id: string): Promise<void> {
	const projects = await load_projects();
	const project = projects.find((item) => item.id === project_id);
	if (!project) throw new Error("QA project not found.");
	const remaining_projects = projects.filter((item) => item.id !== project_id);
	await persist_projects(remaining_projects);
	const active_id = await read_active_project_id();
	if (active_id === project_id) await clear_active_project_id();
}

export async function get_active_project_id(): Promise<string | undefined> {
	return (await get_active_project())?.id;
}

export async function get_active_project(): Promise<Qa_project | undefined> {
	const projects = await load_projects();
	if (projects.length === 0) return undefined;
	const active_id = await read_active_project_id();
	const selected_project = projects.find((project) => project.id === active_id);
	if (selected_project && await project_is_available(selected_project)) return selected_project;
	for (const project of projects) {
		if (await project_is_available(project)) return project;
	}
	return undefined;
}

export async function require_active_project(): Promise<Qa_project> {
	const project = await get_active_project();
	if (!project) throw new Error("Register a QA project first.");
	return project;
}

export async function set_active_project_id(project_id: string): Promise<void> {
	const projects = await load_projects();
	if (!projects.some((project) => project.id === project_id)) {
		throw new Error("QA project not found.");
	}
	mkdirSync(qa_config_dir, { recursive: true });
	const body = `${JSON.stringify({ project_id }, null, "\t")}\n`;
	await Bun.write(active_project_path, body);
}

export async function update_project_visual_max_pages(project_id: string, max_pages: number | undefined): Promise<void> {
	if (max_pages !== undefined && (!Number.isInteger(max_pages) || max_pages < 1 || max_pages > 1000)) {
		throw new Error("Max pages must be an integer between 1 and 1000.");
	}
	const projects = await load_projects();
	const project_index = projects.findIndex((project) => project.id === project_id);
	if (project_index < 0) throw new Error("QA project not found.");
	const project = projects[project_index]!;
	if (max_pages === undefined) {
		const { visual_max_pages: removed_max_pages, ...updated_project } = project;
		void removed_max_pages;
		projects[project_index] = updated_project;
	} else {
		projects[project_index] = { ...project, visual_max_pages: max_pages };
	}
	await persist_projects(projects);
}

export async function suites_for_project(project: Qa_project): Promise<Qa_project_suite[]> {
	const manifest = await read_manifest(project.path);
	const scripts = manifest.scripts;
	return qa_suites.map((suite) => ({
		...suite,
		available: suite.required_script === undefined || Boolean(scripts && typeof scripts[suite.required_script] === "string"),
	}));
}

export async function require_project_suite(project_id: string, suite_code: string): Promise<{ project: Qa_project; suite: Qa_suite; }> {
	const project = await find_project(project_id);
	if (!project) throw new Error("QA project not found.");
	const project_suites = await suites_for_project(project);
	const project_suite = project_suites.find((suite) => suite.code === suite_code);
	if (!project_suite) throw new Error(`Unknown QA suite: ${suite_code}`);
	if (!project_suite.available) {
		const required_script = project_suite.required_script;
		if (!required_script) throw new Error(`Invalid unavailable QA suite: ${project_suite.code}`);
		throw new Error(`${project.name} does not define the ${required_script} package script.`);
	}
	return { project, suite: project_suite };
}
