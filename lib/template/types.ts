/**
 * Shared types for the template engine modules.
 */

export type CompiledFn = (props: Record<string, any>, __escape: (x: any) => string, __include: (name: string, d: Record<string, any>) => Promise<string>) => Promise<string>;

export type ResolveResult = { kind: "template"; template_name: string; } | { kind: "raw"; file_path: string; };
