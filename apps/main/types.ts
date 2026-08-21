export type RouteResult = { html: string; status: number; headers?: Record<string, string>; } | { redirect: string; status: number; };
