import { join } from "node:path";

export const MAX_ENV_FILE_BYTES = 1024 * 1024;

export type EnvFile = {
	content: string;
	exists: boolean;
	path: string;
};

export async function read_env_file(project_root: string = process.cwd()): Promise<EnvFile> {
	const env_path = join(project_root, ".env");
	const env_file = Bun.file(env_path);
	const exists = await env_file.exists();
	const content = exists ? await env_file.text() : "";

	return { content, exists, path: env_path };
}

export async function write_env_file(content: string, project_root: string = process.cwd()): Promise<void> {
	const text_encoder = new TextEncoder();
	const content_bytes = text_encoder.encode(content);
	if (content_bytes.byteLength > MAX_ENV_FILE_BYTES) {
		throw new Error("The .env file must be 1 MB or smaller.");
	}

	const env_path = join(project_root, ".env");
	await Bun.write(env_path, content);
}
