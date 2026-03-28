import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
	stripeAccounts,
	webhookEvents,
	syncMappings,
	syncLog,
	jobQueue,
} from "../db/schema.js";
import { zoho } from "../clients/zoho.js";
import { layout } from "../views/layout.js";

const dashboardRouter = new Hono();

// --- Overview ---
dashboardRouter.get("/", (c) => {
	const accounts = db.select().from(stripeAccounts).all();
	const totalEvents = db.select().from(webhookEvents).all().length;
	const failedEvents = db
		.select()
		.from(webhookEvents)
		.all()
		.filter((e) => e.status === "failed").length;
	const totalMappings = db.select().from(syncMappings).all().length;
	const pendingJobs = db
		.select()
		.from(jobQueue)
		.all()
		.filter((j) => j.status === "pending" || j.status === "processing").length;

	const usage = zoho.getUsageStats();

	const recentLogs = db
		.select()
		.from(syncLog)
		.orderBy(syncLog.id)
		.all()
		.reverse()
		.slice(0, 10);

	const html = layout(
		"Dashboard",
		`
		<h3>Overview</h3>
		<div class="grid-stats">
			<article class="stat-card">
				<h2>${accounts.length}</h2>
				<p>Stripe Accounts</p>
			</article>
			<article class="stat-card">
				<h2>${totalMappings}</h2>
				<p>Synced Objects</p>
			</article>
			<article class="stat-card">
				<h2>${totalEvents}</h2>
				<p>Webhook Events</p>
			</article>
			<article class="stat-card">
				<h2>${failedEvents}</h2>
				<p>Failed Events</p>
			</article>
			<article class="stat-card">
				<h2>${pendingJobs}</h2>
				<p>Pending Jobs</p>
			</article>
		</div>

		<h4>Zoho API Usage</h4>
		<div class="grid-stats">
			<article class="stat-card">
				<h2>${usage.daily.apiCalls} / ${usage.daily.limit}</h2>
				<p>API Calls Today</p>
				${usage.daily.percent >= 80 ? `<small style="color:${usage.daily.percent >= 100 ? 'var(--pico-del-color)' : '#f39c12'}">
					${usage.daily.percent >= 100 ? 'LIMIT REACHED' : `${usage.daily.percent}% used`}
				</small>` : ''}
			</article>
			<article class="stat-card">
				<h2>${usage.invoices.yearly} / ${usage.invoices.yearlyLimit}</h2>
				<p>Invoices This Year</p>
				${usage.invoices.percent >= 80 ? `<small style="color:${usage.invoices.percent >= 100 ? 'var(--pico-del-color)' : '#f39c12'}">
					${usage.invoices.percent >= 100 ? 'LIMIT REACHED' : `${usage.invoices.percent}% used`}
				</small>` : ''}
			</article>
			<article class="stat-card">
				<h2>${usage.invoices.monthly}</h2>
				<p>Invoices This Month</p>
			</article>
		</div>

		<h4>Recent Activity</h4>
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>Level</th>
					<th>Message</th>
					<th>Account</th>
				</tr>
			</thead>
			<tbody>
				${recentLogs
					.map(
						(log) => `
					<tr>
						<td>${new Date(log.createdAt).toLocaleString()}</td>
						<td><span class="badge badge-${log.level === "error" ? "error" : log.level === "warn" ? "warning" : "info"}">${log.level}</span></td>
						<td>${escapeHtml(log.message)}</td>
						<td>${log.stripeAccountId || "—"}</td>
					</tr>`,
					)
					.join("")}
				${recentLogs.length === 0 ? '<tr><td colspan="4">No activity yet</td></tr>' : ""}
			</tbody>
		</table>
	`,
	);

	return c.html(html);
});

// --- Accounts ---
dashboardRouter.get("/accounts", (c) => {
	const accounts = db.select().from(stripeAccounts).all();

	const html = layout(
		"Stripe Accounts",
		`
		<h3>Stripe Accounts</h3>

		<details>
			<summary>Add New Account</summary>
			<form hx-post="/api/accounts" hx-target="body" hx-swap="outerHTML"
				  hx-headers='{"Content-Type": "application/json"}'
				  hx-ext="json-enc"
				  onsubmit="event.preventDefault(); const fd = new FormData(this); const data = Object.fromEntries(fd); fetch('/api/accounts', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}).then(()=>location.reload())">
				<label>
					Name
					<input type="text" name="name" placeholder="My Stripe Account" required>
				</label>
				<label>
					Stripe Account ID
					<input type="text" name="stripeAccountId" placeholder="acct_..." required>
				</label>
				<label>
					API Key (Secret)
					<input type="password" name="apiKey" placeholder="sk_live_..." required>
				</label>
				<label>
					Webhook Secret (optional — only needed in webhook mode)
					<input type="password" name="webhookSecret" placeholder="whsec_...">
				</label>
				<label>
					Zoho Clearing Account ID
					<input type="text" name="zohoClearingAccountId" placeholder="Stripe clearing account in Zoho Books">
				</label>
				<label>
					Zoho Bank Account ID
					<input type="text" name="zohoBankAccountId" placeholder="Bank account in Zoho Books">
				</label>
				<label>
					Zoho Fee Account ID
					<input type="text" name="zohoFeeAccountId" placeholder="Expense account for Stripe fees">
				</label>
				<button type="submit">Add Account</button>
			</form>
		</details>

		<table>
			<thead>
				<tr>
					<th>Name</th>
					<th>Account ID</th>
					<th>Status</th>
					<th>Zoho Accounts</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				${accounts
					.map(
						(a) => `
					<tr>
						<td>${escapeHtml(a.name)}</td>
						<td><code>${a.stripeAccountId}</code></td>
						<td><span class="badge badge-${a.isActive ? "success" : "neutral"}">${a.isActive ? "Active" : "Inactive"}</span></td>
						<td>${a.zohoClearingAccountId ? '<span class="badge badge-success">Configured</span>' : '<span class="badge badge-warning">Not set</span>'}</td>
						<td class="actions">
							<button class="outline" style="padding:0.3em 0.8em;font-size:0.85em"
								onclick="document.getElementById('edit-${a.id}').open=!document.getElementById('edit-${a.id}').open">
								Edit
							</button>
							<a href="/dashboard/accounts/${a.id}/backfill" role="button" class="outline secondary" style="padding:0.3em 0.8em;font-size:0.85em">
								Backfill
							</a>
							${a.isActive
								? `<button class="outline contrast" style="padding:0.3em 0.8em;font-size:0.85em"
									onclick="if(confirm('Deactivate this account?'))fetch('/api/accounts/${a.id}',{method:'DELETE'}).then(()=>location.reload())">
									Deactivate
								</button>`
								: `<button class="outline secondary" style="padding:0.3em 0.8em;font-size:0.85em"
									onclick="fetch('/api/accounts/${a.id}',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({isActive:true})}).then(()=>location.reload())">
									Activate
								</button>`
							}
						</td>
					</tr>
					<tr>
						<td colspan="5" style="padding:0;border:none">
							<details id="edit-${a.id}" style="margin:0;padding:0 1rem">
								<summary style="display:none"></summary>
								<form style="padding:1rem 0" onsubmit="event.preventDefault(); const fd = new FormData(this); const data = Object.fromEntries(fd); fetch('/api/accounts/${a.id}', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)}).then(()=>location.reload())">
									<div class="grid">
										<label>
											Name
											<input type="text" name="name" value="${escapeHtml(a.name)}">
										</label>
										<label>
											API Key (leave empty to keep current)
											<input type="password" name="apiKey" placeholder="sk_live_...">
										</label>
										<label>
											Webhook Secret (leave empty to keep current)
											<input type="password" name="webhookSecret" placeholder="whsec_...">
										</label>
									</div>
									<div class="grid">
										<label>
											Stripe Clearing Account ID (Zoho) *
											<input type="text" name="zohoClearingAccountId" value="${escapeHtml(a.zohoClearingAccountId || "")}" placeholder="Asset account for Stripe balance">
											<small>Required — fees and sales are recorded here</small>
										</label>
										<label>
											Bank Account ID (Zoho)
											<input type="text" name="zohoBankAccountId" value="${escapeHtml(a.zohoBankAccountId || "")}" placeholder="Bank account for payouts">
											<small>For payout transfers from clearing to bank</small>
										</label>
										<label>
											Fee Account ID (Zoho)
											<input type="text" name="zohoFeeAccountId" value="${escapeHtml(a.zohoFeeAccountId || "")}" placeholder="Expense account for Stripe fees">
											<small>Zoho expense account for Stripe processing fees</small>
										</label>
									</div>
									<button type="submit" style="width:auto">Save</button>
								</form>
							</details>
						</td>
					</tr>`,
					)
					.join("")}
				${accounts.length === 0 ? '<tr><td colspan="5">No accounts added yet</td></tr>' : ""}
			</tbody>
		</table>
	`,
	);

	return c.html(html);
});

// --- Backfill ---
dashboardRouter.get("/accounts/:id/backfill", (c) => {
	const id = Number(c.req.param("id"));
	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) {
		return c.html(layout("Not Found", "<h3>Account not found</h3>"), 404);
	}

	const html = layout(
		`Backfill — ${account.name}`,
		`
		<h3>Backfill: ${escapeHtml(account.name)}</h3>
		<p>Preview Stripe transactions before syncing them to Zoho Books.</p>

		<form id="preview-form" style="margin-bottom:1rem">
			<div class="grid">
				<label>
					From Date
					<input type="date" name="from" id="bf-from">
				</label>
				<label>
					To Date
					<input type="date" name="to" id="bf-to">
				</label>
				<label>
					&nbsp;
					<button type="submit" id="preview-btn">Preview Transactions</button>
				</label>
			</div>
		</form>

		<div id="preview-result"></div>

		<script>
		document.getElementById('preview-form').addEventListener('submit', async (e) => {
			e.preventDefault();
			const from = document.getElementById('bf-from').value;
			const to = document.getElementById('bf-to').value;
			const btn = document.getElementById('preview-btn');
			btn.setAttribute('aria-busy', 'true');
			btn.textContent = 'Loading...';

			const params = new URLSearchParams();
			if (from) params.set('from', from);
			if (to) params.set('to', to);

			try {
				const res = await fetch('/api/accounts/${id}/backfill/preview?' + params);
				const data = await res.json();
				renderPreview(data, from, to);
			} catch (err) {
				document.getElementById('preview-result').innerHTML = '<p style="color:var(--pico-del-color)">Failed to load preview: ' + err.message + '</p>';
			}
			btn.removeAttribute('aria-busy');
			btn.textContent = 'Preview Transactions';
		});

		function statusBadge(status) {
			if (status === 'synced') return '<span class=\\"badge badge-neutral\\">Synced</span>';
			if (status === 'exists_in_zoho') return '<span class=\\"badge badge-warning\\">In Zoho</span>';
			return '<span class=\\"badge badge-info\\">New</span>';
		}

		function renderPreview(data, from, to) {
			const t = data.totals;
			let html = '<article>';
			html += '<h4>Summary</h4>';
			html += '<div class="grid-stats">';
			html += '<div class="stat-card"><h2>' + t.customers + '</h2><p>Customers</p></div>';
			html += '<div class="stat-card"><h2>' + t.invoices + '</h2><p>Invoices</p></div>';
			html += '<div class="stat-card"><h2>' + t.charges + '</h2><p>Charges</p></div>';
			html += '<div class="stat-card"><h2>' + t.fees + '</h2><p>Fees</p></div>';
			html += '<div class="stat-card"><h2>' + t.refunds + '</h2><p>Refunds</p></div>';
			html += '<div class="stat-card"><h2>' + t.payouts + '</h2><p>Payouts</p></div>';
			html += '</div>';
			html += '<p><strong>' + t.toSync + '</strong> new to sync, <strong>' + t.existsInZoho + '</strong> already in Zoho (will be skipped), <strong>' + t.alreadySynced + '</strong> previously synced</p>';

			if (t.toSync > 0) {
				html += '<button id="run-backfill-btn" onclick="runBackfill(\\'' + (from||'') + '\\', \\'' + (to||'') + '\\')">Sync ' + t.toSync + ' New Transactions to Zoho Books</button>';
			} else {
				html += '<p><strong>Everything is already synced.</strong></p>';
			}
			html += '</article>';

			// Invoices table
			if (data.invoices.length > 0) {
				html += '<h4>Invoices (' + data.invoices.length + ')</h4><table><thead><tr><th>Date</th><th>Number</th><th>Amount</th><th>Customer</th><th>Status</th><th>Action</th></tr></thead><tbody>';
				for (const inv of data.invoices) {
					let action = '';
					if (inv.status === 'new') {
						action = '<button class="outline" onclick="syncOne(this, \\'' + inv.id + '\\', \\'invoice\\')">Send to Zoho</button>';
					} else if (inv.status === 'exists_in_zoho' && inv.zohoId) {
						action = '<button class="outline secondary" onclick="updateZoho(this, \\'' + inv.zohoId + '\\', \\'' + inv.id + '\\', \\'' + (inv.number||'') + '\\', \\'invoice\\', \\'' + (inv.zohoTxnType||'') + '\\')">Update Zoho</button>';
					}
					html += '<tr><td>' + inv.date + '</td><td>' + (inv.number||inv.id) + '</td><td>' + inv.amount + ' ' + inv.currency + '</td><td>' + inv.customer + '</td><td>' + statusBadge(inv.status) + '</td><td>' + action + '</td></tr>';
				}
				html += '</tbody></table>';
			}

			// Charges table
			if (data.charges.length > 0) {
				html += '<h4>Standalone Charges (' + data.charges.length + ')</h4><table><thead><tr><th>Date</th><th>Amount</th><th>Description</th><th>Status</th><th>Action</th></tr></thead><tbody>';
				for (const ch of data.charges) {
					let action = '';
					if (ch.status === 'new') {
						action = '<button class="outline" onclick="syncOne(this, \\'' + ch.id + '\\', \\'charge\\')">Send to Zoho</button>';
					} else if (ch.status === 'exists_in_zoho' && ch.zohoId) {
						action = '<button class="outline secondary" onclick="updateZoho(this, \\'' + ch.zohoId + '\\', \\'' + ch.id + '\\', \\'\\', \\'charge\\', \\'' + (ch.zohoTxnType||'') + '\\')">Update Zoho</button>';
					}
					html += '<tr><td>' + ch.date + '</td><td>' + ch.amount + ' ' + ch.currency + '</td><td>' + (ch.description||'—') + '</td><td>' + statusBadge(ch.status) + '</td><td>' + action + '</td></tr>';
				}
				html += '</tbody></table>';
			}

			// Fees table
			if (data.fees.length > 0) {
				html += '<h4>Stripe Fees (' + data.fees.length + ')</h4><table><thead><tr><th>Date</th><th>Amount</th><th>Description</th><th>Source</th><th>Status</th><th>Action</th></tr></thead><tbody>';
				for (const f of data.fees) {
					let action = '';
					if (f.status === 'new') {
						action = '<button class="outline" onclick="syncOne(this, \\'' + f.id + '\\', \\'fee\\')">Send to Zoho</button>';
					} else if (f.status === 'exists_in_zoho' && f.zohoId) {
						action = '<button class="outline secondary" onclick="updateZoho(this, \\'' + f.zohoId + '\\', \\'' + f.id + '\\', \\'\\', \\'fee\\', \\'' + (f.zohoTxnType||'') + '\\')">Update Zoho</button>';
					}
					html += '<tr><td>' + f.date + '</td><td>' + f.amount + ' ' + f.currency + '</td><td>' + (f.description||'—') + '</td><td><code>' + f.source + '</code></td><td>' + statusBadge(f.status) + '</td><td>' + action + '</td></tr>';
				}
				html += '</tbody></table>';
			}

			// Refunds table
			if (data.refunds.length > 0) {
				html += '<h4>Refunds (' + data.refunds.length + ')</h4><table><thead><tr><th>Date</th><th>Amount</th><th>Charge</th><th>Status</th><th>Action</th></tr></thead><tbody>';
				for (const r of data.refunds) {
					let action = '';
					if (r.status === 'new') {
						action = '<button class="outline" onclick="syncOne(this, \\'' + r.id + '\\', \\'refund\\')">Send to Zoho</button>';
					}
					html += '<tr><td>' + r.date + '</td><td>' + r.amount + ' ' + r.currency + '</td><td>' + r.chargeId + '</td><td>' + statusBadge(r.status) + '</td><td>' + action + '</td></tr>';
				}
				html += '</tbody></table>';
			}

			// Payouts table
			if (data.payouts.length > 0) {
				html += '<h4>Payouts (' + data.payouts.length + ')</h4><table><thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>';
				for (const p of data.payouts) {
					let action = '';
					if (p.status === 'new') {
						action = '<button class="outline" onclick="syncOne(this, \\'' + p.id + '\\', \\'payout\\')">Send to Zoho</button>';
					} else if (p.status === 'exists_in_zoho' && p.zohoId) {
						action = '<button class="outline secondary" onclick="updateZoho(this, \\'' + p.zohoId + '\\', \\'' + p.id + '\\', \\'\\', \\'payout\\', \\'' + (p.zohoTxnType||'') + '\\')">Update Zoho</button>';
					}
					html += '<tr><td>' + p.date + '</td><td>' + p.amount + ' ' + p.currency + '</td><td>' + statusBadge(p.status) + '</td><td>' + action + '</td></tr>';
				}
				html += '</tbody></table>';
			}

			document.getElementById('preview-result').innerHTML = html;
		}

		async function syncOne(btn, stripeId, type) {
			btn.setAttribute('aria-busy', 'true');
			btn.textContent = 'Syncing...';
			btn.disabled = true;
			try {
				const res = await fetch('/api/accounts/${id}/backfill/sync-one', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({ stripeId, type })
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || 'Failed');
				btn.textContent = 'Synced';
				btn.removeAttribute('aria-busy');
				btn.closest('tr').querySelector('td:nth-last-child(2)').innerHTML = '<span class="badge badge-neutral">Synced</span>';
			} catch (err) {
				btn.textContent = 'Failed';
				btn.removeAttribute('aria-busy');
				btn.disabled = false;
				btn.title = err.message;
			}
		}

		async function updateZoho(btn, zohoId, stripeId, stripeNumber, type, zohoTxnType) {
			btn.setAttribute('aria-busy', 'true');
			btn.textContent = 'Updating...';
			btn.disabled = true;
			try {
				const res = await fetch('/api/accounts/${id}/backfill/update-zoho', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({ zohoTransactionId: zohoId, stripeId, stripeNumber, type, zohoTxnType })
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || 'Failed');
				btn.textContent = 'Updated';
				btn.removeAttribute('aria-busy');
				btn.closest('tr').querySelector('td:nth-last-child(2)').innerHTML = '<span class="badge badge-neutral">Synced</span>';
			} catch (err) {
				btn.textContent = 'Failed';
				btn.removeAttribute('aria-busy');
				btn.disabled = false;
				btn.title = err.message;
			}
		}

		async function runBackfill(from, to) {
			const btn = document.getElementById('run-backfill-btn');
			btn.setAttribute('aria-busy', 'true');
			btn.textContent = 'Syncing...';
			btn.disabled = true;
			try {
				await fetch('/api/accounts/${id}/backfill', {
					method: 'POST',
					headers: {'Content-Type': 'application/json'},
					body: JSON.stringify({from: from || undefined, to: to || undefined})
				});
				btn.textContent = 'Backfill started — refreshing preview...';
				// Poll until the job finishes (new items become synced)
				let attempts = 0;
				const poll = setInterval(async () => {
					attempts++;
					try {
						const params = new URLSearchParams();
						if (from) params.set('from', from);
						if (to) params.set('to', to);
						const res = await fetch('/api/accounts/${id}/backfill/preview?' + params);
						const data = await res.json();
						if (data.totals.toSync === 0 || attempts >= 30) {
							clearInterval(poll);
							renderPreview(data, from, to);
						}
					} catch {
						if (attempts >= 30) clearInterval(poll);
					}
				}, 5000);
			} catch (err) {
				btn.textContent = 'Failed: ' + err.message;
				btn.removeAttribute('aria-busy');
				btn.disabled = false;
			}
		}
		</script>
	`,
	);

	return c.html(html);
});

// --- Errors ---
dashboardRouter.get("/errors", (c) => {
	const failedEvents = db
		.select()
		.from(webhookEvents)
		.all()
		.filter((e) => e.status === "failed")
		.reverse()
		.slice(0, 50);

	const deadJobs = db
		.select()
		.from(jobQueue)
		.all()
		.filter((j) => j.status === "dead")
		.reverse()
		.slice(0, 50);

	const html = layout(
		"Errors",
		`
		<h3>Failed Events</h3>
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>Event Type</th>
					<th>Account</th>
					<th>Error</th>
					<th>Attempts</th>
					<th>Action</th>
				</tr>
			</thead>
			<tbody>
				${failedEvents
					.map(
						(e) => `
					<tr>
						<td>${new Date(e.createdAt).toLocaleString()}</td>
						<td><code>${e.eventType}</code></td>
						<td>${e.stripeAccountId}</td>
						<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.errorMessage || "—")}</td>
						<td>${e.attempts}</td>
						<td>
							<button class="outline" style="padding:0.3em 0.8em;font-size:0.85em"
								onclick="fetch('/api/events/${e.id}/retry',{method:'POST'}).then(()=>location.reload())">
								Retry
							</button>
						</td>
					</tr>`,
					)
					.join("")}
				${failedEvents.length === 0 ? '<tr><td colspan="6">No failed events</td></tr>' : ""}
			</tbody>
		</table>

		<h3>Dead Jobs</h3>
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>Type</th>
					<th>Error</th>
					<th>Attempts</th>
				</tr>
			</thead>
			<tbody>
				${deadJobs
					.map(
						(j) => `
					<tr>
						<td>${new Date(j.createdAt).toLocaleString()}</td>
						<td><code>${j.jobType}</code></td>
						<td style="max-width:400px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(j.lastError || "—")}</td>
						<td>${j.attempts}</td>
					</tr>`,
					)
					.join("")}
				${deadJobs.length === 0 ? '<tr><td colspan="4">No dead jobs</td></tr>' : ""}
			</tbody>
		</table>
	`,
	);

	return c.html(html);
});

// --- Activity Log ---
dashboardRouter.get("/log", (c) => {
	const logs = db
		.select()
		.from(syncLog)
		.orderBy(syncLog.id)
		.all()
		.reverse()
		.slice(0, 100);

	const html = layout(
		"Activity Log",
		`
		<h3>Activity Log</h3>
		<table>
			<thead>
				<tr>
					<th>Time</th>
					<th>Level</th>
					<th>Account</th>
					<th>Message</th>
				</tr>
			</thead>
			<tbody>
				${logs
					.map(
						(log) => `
					<tr>
						<td>${new Date(log.createdAt).toLocaleString()}</td>
						<td><span class="badge badge-${log.level === "error" ? "error" : log.level === "warn" ? "warning" : "info"}">${log.level}</span></td>
						<td>${log.stripeAccountId || "—"}</td>
						<td>${escapeHtml(log.message)}</td>
					</tr>`,
					)
					.join("")}
				${logs.length === 0 ? '<tr><td colspan="4">No activity yet</td></tr>' : ""}
			</tbody>
		</table>
	`,
	);

	return c.html(html);
});

// --- Settings ---
dashboardRouter.get("/settings", (c) => {
	const html = layout(
		"Settings",
		`
		<h3>Settings</h3>
		<p>Zoho Books account IDs for fee tracking and payout reconciliation are now configured
		<strong>per Stripe account</strong>. Go to <a href="/dashboard/accounts">Accounts</a> and click
		<strong>Edit</strong> on each account to set them.</p>
		<p>You can find your Zoho chart-of-account IDs in Zoho Books under Accountant &gt; Chart of Accounts.</p>
	`,
	);

	return c.html(html);
});

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

export { dashboardRouter };
