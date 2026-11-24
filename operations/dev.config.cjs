// pm2 start operations/dev.config.cjs
// pm2 logs

module.exports = {
	apps: [
		{
			name: "tw",
			script: "bun",
			args: "css:watch",
			watch: true,
		},
		{
			name: "dev",
			script: "bun",
			args: "development",
			watch: true,
		},
	],
};
