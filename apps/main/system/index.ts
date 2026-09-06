// The system(non-auth) admin pages moved to the sibling apps/reeman/ folder,
// served by their own process (apps/reeman/server.ts). Shared auth moved the other
// way, to platform/auth/, so every app imports it from outside the app trees.
// This barrel is retained purely so the release override
// (apps/main/routes.override.ts) keeps resolving the full system route set for the
// single-process public build; the dev main app no longer imports it.
// Aggregation + feature gating live in apps/reeman/system_routes.ts.
export { route_definitions } from "$reeman/system_routes";
