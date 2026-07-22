import type { BunRequest } from "bun";

export type Handler = (req: BunRequest) => Response | Promise<Response>;
export type Middleware = (req: BunRequest, next: Handler) => Response | Promise<Response>;

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

// A route can be a single handler or a map of HTTP method -> handler
export type RouteHandler = Handler | Partial<Record<Method, Handler>>;
export type RouteTable = Record<string, RouteHandler>;
