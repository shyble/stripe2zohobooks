export function layout(title: string, content: string): string {
	return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title} — stripe2zohobooks</title>
	<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
	<script src="https://unpkg.com/htmx.org@2.0.4"></script>
	<style>
		:root { --pico-font-size: 15px; }
		nav { margin-bottom: 1rem; }
		.badge {
			display: inline-block;
			padding: 0.15em 0.5em;
			border-radius: 4px;
			font-size: 0.8em;
			font-weight: 600;
		}
		.badge-success { background: #2ecc71; color: white; }
		.badge-error { background: #e74c3c; color: white; }
		.badge-warning { background: #f39c12; color: white; }
		.badge-info { background: #3498db; color: white; }
		.badge-neutral { background: #95a5a6; color: white; }
		.stat-card {
			text-align: center;
			padding: 1rem;
		}
		.stat-card h2 { margin-bottom: 0.2rem; }
		.stat-card p { margin: 0; color: var(--pico-muted-color); }
		.grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
		table { font-size: 0.9em; }
		.actions { display: flex; gap: 0.5rem; }
	</style>
</head>
<body>
	<nav class="container">
		<ul>
			<li><strong>stripe2zohobooks</strong></li>
		</ul>
		<ul>
			<li><a href="/dashboard">Dashboard</a></li>
			<li><a href="/dashboard/accounts">Accounts</a></li>
			<li><a href="/dashboard/errors">Errors</a></li>
			<li><a href="/dashboard/log">Activity Log</a></li>
			<li><a href="/dashboard/settings">Settings</a></li>
		</ul>
	</nav>
	<main class="container">
		${content}
	</main>
</body>
</html>`;
}
