#!/usr/bin/env bun

// Thin CLI entry - delegates to the extracted modules under generator/crud/
import { main } from "./crud/main";

await main();
