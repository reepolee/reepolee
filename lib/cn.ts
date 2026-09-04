/**
 * Server-side Tailwind class joining for .ree templates.
 *
 * The implementation is vendored so rendering does not add a package or
 * browser dependency. Keep this wrapper behavior-neutral: cn owns joining
 * and Tailwind conflict resolution.
 */

import { cn as vendored_cn } from "$vendor/cn.min.js";

export type Cn_input =
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| Cn_input[]
	| Record<string, unknown>;

export function cn(...inputs: Cn_input[]): string {
	return vendored_cn(...inputs as any);
}
