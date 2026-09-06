import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const project_root = process.cwd();
const markdown_glob = new Bun.Glob("**/*.md");
const markdown_files: string[] = [];

for await (const file of markdown_glob.scan({ cwd: project_root, onlyFiles: true })) {
	const normalized_file = file.replaceAll("\\", "/");
	if (normalized_file.startsWith("node_modules/") || normalized_file.startsWith("vendor/") || normalized_file.startsWith(".agents/")) continue;
	markdown_files.push(normalized_file);
}

const link_pattern = /!?\[[^\]]*\]\(([^\s)#]+)(?:\s+[^)]*)?(?:#[^)]*)?\)/g;
const broken_links: string[] = [];

for (const file of markdown_files) {
	const absolute_file = resolve(project_root, file);
	const content = await Bun.file(absolute_file).text();
	const directory = dirname(absolute_file);
	const matches = content.matchAll(link_pattern);

	for (const match of matches) {
		const target = match[1];
		if (!target || target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

		const target_path = resolve(directory, target);
		const target_exists = existsSync(target_path);
		if (!target_exists) broken_links.push(`${file} -> ${target}`);
	}
}

if (broken_links.length > 0) {
	console.error("Broken relative Markdown links:");
	for (const link of broken_links.sort()) console.error(`- ${link}`);
	process.exit(1);
}

console.log(`Documentation links verified: ${markdown_files.length} Markdown files.`);
