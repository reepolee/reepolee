#!/usr/bin/env bun

Bun.env.MCP_STDIO = "true";
Bun.env.MCP_TRANSPORT = "stdio";
await import("./index");
