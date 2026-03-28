import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import {
	stripeAccounts,
	webhookEvents,
	jobQueue,
	syncLog,
	syncMappings,
	zohoConfig,
} from "../db/schema.js";
import { clearClientCache } from "../clients/stripe.js";
import { zoho } from "../clients/zoho.js";
import { encrypt } from "../utils/crypto.js";
import { enqueueJob } from "../queue/scheduler.js";
import { logger } from "../utils/logger.js";
import { createMapping, logSync } from "../utils/idempotency.js";

const apiRouter = new Hono();

// --- Stripe Accounts ---

const createAccountSchema = z.object({
	name: z.string().min(1),
	stripeAccountId: z.string().min(1),
	apiKey: z.string().min(1),
	webhookSecret: z.string().optional(),
	zohoClearingAccountId: z.string().optional(),
	zohoBankAccountId: z.string().optional(),
	zohoFeeAccountId: z.string().optional(),
});

apiRouter.get("/accounts", (c) => {
	const accounts = db
		.select({
			id: stripeAccounts.id,
			name: stripeAccounts.name,
			stripeAccountId: stripeAccounts.stripeAccountId,
			isActive: stripeAccounts.isActive,
			createdAt: stripeAccounts.createdAt,
		})
		.from(stripeAccounts)
		.all();

	return c.json({ accounts });
});

apiRouter.post("/accounts", async (c) => {
	const body = await c.req.json();
	const parsed = createAccountSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: parsed.error.flatten() }, 400);
	}

	const { name, stripeAccountId, apiKey, webhookSecret, zohoClearingAccountId, zohoBankAccountId, zohoFeeAccountId } = parsed.data;

	// Check for duplicate
	const existing = db
		.select({ id: stripeAccounts.id })
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (existing) {
		return c.json({ error: "Account already exists" }, 409);
	}

	const result = db
		.insert(stripeAccounts)
		.values({
			name,
			stripeAccountId,
			apiKey: encrypt(apiKey),
			webhookSecret: webhookSecret ? encrypt(webhookSecret) : null,
			zohoClearingAccountId: zohoClearingAccountId || null,
			zohoBankAccountId: zohoBankAccountId || null,
			zohoFeeAccountId: zohoFeeAccountId || null,
		})
		.run();

	logger.info({ stripeAccountId, name }, "Stripe account added");

	return c.json(
		{
			account: {
				id: result.lastInsertRowid,
				name,
				stripeAccountId,
				isActive: true,
			},
		},
		201,
	);
});

apiRouter.put("/accounts/:id", async (c) => {
	const id = Number(c.req.param("id"));
	const body = await c.req.json();

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) {
		return c.json({ error: "Account not found" }, 404);
	}

	const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
	if (body.name) updates.name = body.name;
	if (body.apiKey) updates.apiKey = encrypt(body.apiKey);
	if (body.webhookSecret) updates.webhookSecret = encrypt(body.webhookSecret);
	if (body.isActive !== undefined) updates.isActive = body.isActive;
	if (body.zohoFeeAccountId !== undefined) updates.zohoFeeAccountId = body.zohoFeeAccountId || null;
	if (body.zohoClearingAccountId !== undefined) updates.zohoClearingAccountId = body.zohoClearingAccountId || null;
	if (body.zohoBankAccountId !== undefined) updates.zohoBankAccountId = body.zohoBankAccountId || null;

	db.update(stripeAccounts).set(updates).where(eq(stripeAccounts.id, id)).run();

	// Clear cached client if API key changed
	if (body.apiKey) {
		clearClientCache(account.stripeAccountId);
	}

	return c.json({ success: true });
});

apiRouter.delete("/accounts/:id", (c) => {
	const id = Number(c.req.param("id"));

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) {
		return c.json({ error: "Account not found" }, 404);
	}

	// Soft delete — mark inactive
	db.update(stripeAccounts)
		.set({ isActive: false, updatedAt: new Date().toISOString() })
		.where(eq(stripeAccounts.id, id))
		.run();

	clearClientCache(account.stripeAccountId);

	logger.info({ stripeAccountId: account.stripeAccountId }, "Stripe account deactivated");

	return c.json({ success: true });
});

// --- Account Status ---

apiRouter.get("/accounts/:id/status", (c) => {
	const id = Number(c.req.param("id"));

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) {
		return c.json({ error: "Account not found" }, 404);
	}

	const accountId = account.stripeAccountId;

	const totalEvents = db
		.select({ id: webhookEvents.id })
		.from(webhookEvents)
		.where(eq(webhookEvents.stripeAccountId, accountId))
		.all().length;

	const failedEvents = db
		.select({ id: webhookEvents.id })
		.from(webhookEvents)
		.where(
			eq(webhookEvents.stripeAccountId, accountId),
		)
		.all()
		.filter((e) => {
			const event = db
				.select({ status: webhookEvents.status })
				.from(webhookEvents)
				.where(eq(webhookEvents.id, e.id))
				.get();
			return event?.status === "failed";
		}).length;

	const totalMappings = db
		.select({ id: syncMappings.id })
		.from(syncMappings)
		.where(eq(syncMappings.stripeAccountId, accountId))
		.all().length;

	return c.json({
		account: {
			name: account.name,
			stripeAccountId: accountId,
			isActive: account.isActive,
		},
		stats: {
			totalEvents,
			failedEvents,
			totalMappings,
		},
	});
});

// --- Backfill ---

apiRouter.get("/accounts/:id/backfill/preview", async (c) => {
	const id = Number(c.req.param("id"));
	const dateFrom = c.req.query("from") || undefined;
	const dateTo = c.req.query("to") || undefined;

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) {
		return c.json({ error: "Account not found" }, 404);
	}

	const { previewBackfill } = await import("../backfill/runner.js");
	const preview = await previewBackfill(account.stripeAccountId, dateFrom, dateTo);
	return c.json(preview);
});

apiRouter.post("/accounts/:id/backfill", async (c) => {
	const id = Number(c.req.param("id"));
	const body = await c.req.json().catch(() => ({}));
	const dateFrom = (body as Record<string, string>).from || undefined;
	const dateTo = (body as Record<string, string>).to || undefined;

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) {
		return c.json({ error: "Account not found" }, 404);
	}

	enqueueJob("backfill", {
		stripeAccountId: account.stripeAccountId,
		dateFrom,
		dateTo,
	});

	return c.json({ success: true, message: "Backfill job enqueued" });
});

// Update an existing Zoho bank transaction with Stripe reference data
apiRouter.post("/accounts/:id/backfill/update-zoho", async (c) => {
	const id = Number(c.req.param("id"));
	const body = await c.req.json() as {
		zohoTransactionId: string;
		stripeId: string;
		stripeNumber?: string;
		type: string;
		zohoTxnType?: string;
	};

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) return c.json({ error: "Account not found" }, 404);

	try {
		if (body.zohoTxnType === "expense") {
			await zoho.updateExpense(body.zohoTransactionId, {
				reference_number: body.stripeId,
			});
		} else {
			const existing = await zoho.getBankTransaction(body.zohoTransactionId);
			const txn = existing.banktransaction;
			await zoho.updateBankTransaction(body.zohoTransactionId, {
				transaction_type: txn.transaction_type,
				from_account_id: txn.from_account_id,
				to_account_id: txn.to_account_id,
				currency_id: txn.currency_id,
				amount: txn.amount,
				date: txn.date,
				exchange_rate: txn.exchange_rate,
				description: txn.description,
				reference_number: body.stripeId,
			});
		}

		createMapping({
			stripeAccountId: account.stripeAccountId,
			stripeObjectType: body.type,
			stripeObjectId: body.stripeId,
			zohoEntityType: "banktransaction",
			zohoEntityId: body.zohoTransactionId,
		});

		logSync(
			"info",
			`Updated Zoho transaction ${body.zohoTransactionId} with Stripe ref ${body.stripeNumber || body.stripeId}`,
			account.stripeAccountId,
			{ zohoTransactionId: body.zohoTransactionId, stripeId: body.stripeId },
		);

		return c.json({ success: true });
	} catch (err) {
		logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to update Zoho transaction");
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

// Sync a single new item to Zoho
apiRouter.post("/accounts/:id/backfill/sync-one", async (c) => {
	const id = Number(c.req.param("id"));
	const body = await c.req.json() as {
		stripeId: string;
		type: "invoice" | "charge" | "fee" | "refund" | "payout";
	};

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.id, id))
		.get();

	if (!account) return c.json({ error: "Account not found" }, 404);

	try {
		const { getStripeClient } = await import("../clients/stripe.js");
		const stripe = getStripeClient(account.stripeAccountId);

		if (body.type === "invoice") {
			const invoice = await stripe.invoices.retrieve(body.stripeId);
			const { syncInvoicePaid } = await import("../sync/invoices.js");
			await syncInvoicePaid(account.stripeAccountId, invoice);
		} else if (body.type === "charge") {
			const charge = await stripe.charges.retrieve(body.stripeId);
			const { syncChargeSucceeded } = await import("../sync/payments.js");
			await syncChargeSucceeded(account.stripeAccountId, charge);
		} else if (body.type === "refund") {
			const refund = await stripe.refunds.retrieve(body.stripeId);
			const { syncRefundCreated } = await import("../sync/refunds.js");
			await syncRefundCreated(account.stripeAccountId, refund);
		} else if (body.type === "payout") {
			const payout = await stripe.payouts.retrieve(body.stripeId);
			const { syncPayoutPaid } = await import("../sync/payouts.js");
			await syncPayoutPaid(account.stripeAccountId, payout);
		} else if (body.type === "fee") {
			const bt = await stripe.balanceTransactions.retrieve(body.stripeId);
			if (bt.type === "charge" && bt.source) {
				// Charge-related fee — sync via the charge
				const chargeId = typeof bt.source === "string" ? bt.source : (bt.source as { id: string }).id;
				const charge = await stripe.charges.retrieve(chargeId);
				const { syncStripeFees } = await import("../sync/fees.js");
				await syncStripeFees(account.stripeAccountId, charge);
			} else {
				const { syncStandaloneStripeFee } = await import("../sync/fees.js");
				await syncStandaloneStripeFee(account.stripeAccountId, bt);
			}
		}

		return c.json({ success: true });
	} catch (err) {
		logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to sync item to Zoho");
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

// --- Events ---

apiRouter.get("/events", (c) => {
	const limit = Number(c.req.query("limit") || "50");
	const status = c.req.query("status");
	const accountId = c.req.query("accountId");

	let query = db.select().from(webhookEvents);

	// Note: filtering is done in-memory for simplicity with SQLite
	const events = query.orderBy(webhookEvents.id).all().reverse().slice(0, limit);

	const filtered = events.filter((e) => {
		if (status && e.status !== status) return false;
		if (accountId && e.stripeAccountId !== accountId) return false;
		return true;
	});

	return c.json({ events: filtered });
});

// --- Retry Event ---

apiRouter.post("/events/:id/retry", (c) => {
	const id = Number(c.req.param("id"));

	const event = db
		.select()
		.from(webhookEvents)
		.where(eq(webhookEvents.id, id))
		.get();

	if (!event) {
		return c.json({ error: "Event not found" }, 404);
	}

	db.update(webhookEvents)
		.set({ status: "pending", errorMessage: null })
		.where(eq(webhookEvents.id, id))
		.run();

	enqueueJob("process_event", {
		eventId: event.eventId,
		stripeAccountId: event.stripeAccountId,
	});

	return c.json({ success: true });
});

// --- Jobs ---

apiRouter.get("/jobs", (c) => {
	const jobs = db
		.select()
		.from(jobQueue)
		.orderBy(jobQueue.id)
		.all()
		.reverse()
		.slice(0, 50);

	return c.json({ jobs });
});

// --- Sync Log ---

apiRouter.get("/sync-log", (c) => {
	const limit = Number(c.req.query("limit") || "100");
	const logs = db
		.select()
		.from(syncLog)
		.orderBy(syncLog.id)
		.all()
		.reverse()
		.slice(0, limit);

	return c.json({ logs });
});

// --- Settings ---

apiRouter.put("/settings/zoho-accounts", async (c) => {
	const body = await c.req.json();

	const cfg = db.select().from(zohoConfig).where(eq(zohoConfig.id, 1)).get();
	if (!cfg) {
		return c.json({ error: "Zoho Books not configured yet" }, 400);
	}

	db.update(zohoConfig)
		.set({
			stripeFeeAccountId: body.stripeFeeAccountId || null,
			stripeClearingAccountId: body.stripeClearingAccountId || null,
			bankAccountId: body.bankAccountId || null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(zohoConfig.id, 1))
		.run();

	return c.json({ success: true });
});

// --- Usage ---

apiRouter.get("/usage", (c) => {
	return c.json(zoho.getUsageStats());
});

// --- Health ---

apiRouter.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export { apiRouter };
