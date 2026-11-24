export {};

declare global {
	/**
	 * Global HTML tagged template helper.
	 * Runtime value must be assigned separately (globalThis.html = String.raw)
	 *
	 * WARNING: Do NOT declare any function parameter named `html` - it shadows
	 * this global and causes runtime errors when used as a tagged template
	 * literal (e.g. html`<div>...`). Rename the param to `html_content` or similar.
	 */
	const html: typeof String.raw;
}

declare module "*.sql" {
	const content: string;
	export default content;
}
