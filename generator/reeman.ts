#!/usr/bin/env bun
/**
 * reeman wrapper around the resource generator.
 *
 * Usage:  bun generator/reeman.ts
 *
 * Delegates to generator/reeman/index.ts for the actual implementation.
 */

import { main } from "./reeman/index";
import { color, RED } from "./reeman/ui";

main().catch((err) => {
	console.error(`${color("Unexpected error:", RED)}`, err);
	process.exit(1);
});
