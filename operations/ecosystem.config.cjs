module.exports = {
	apps: [
		{
			name: "reepolee",
			script: "./operations/start_reepolee.sh",
			autorestart: true,
			watch: true,
		},
		{
			name: "worker",
			script: "./operations/start_worker.sh",
			autorestart: true,
			watch: false,
		},
	],
};
