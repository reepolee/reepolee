// Start from the repository root: pm2 start operations/mcp.config.cjs
// MCP_HTTP_TOKEN must be configured in .env before starting.

module.exports = {
	apps: [
		{
			name: "reepolee-mcp",
			script: "bun",
			args: "scripts/mcp/http.ts",
			autorestart: true,
			watch: false,
			instances: 1,
		},
	],
};
