#!/usr/bin/env bun

// Add-locale runner - executes the AI add-locale workflow in its own process
// so it survives bun --hot reloads of the reeman server (same rationale as
// nested_children_runner.ts and the spawned CRUD generation). The web UI
// spawns this from spawn_add_locale_action(); stdout/stderr are piped back to
// the parent, which persists them to the run log and clears the busy key on
// exit.

import { add_locale_to_system } from "$generator/add_locale";

type RunnerPayload = {
	locale_code: string;
	translate: boolean;
};

const raw_payload = Bun.argv[2];
if (!raw_payload) throw new Error("Add locale runner requires a payload.");
const payload = JSON.parse(raw_payload) as RunnerPayload;
if (!payload.locale_code) throw new Error("Add locale runner received an invalid payload.");

const ok = await add_locale_to_system(payload.locale_code, { translate: payload.translate === true });
console.log(ok ? `Add locale complete: ${payload.locale_code}.` : `Add locale failed: ${payload.locale_code}.`);
process.exit(ok ? 0 : 1);
