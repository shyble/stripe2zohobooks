import { Hono } from "hono";
import Stripe from "stripe";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { webhookEvents, stripeAccounts } from "../db/schema.js";
import { getWebhookSecret } from "../clients/stripe.js";
import { enqueueJob } from "../queue/scheduler.js";
import { logger } from "../utils/logger.js";

const webhookRouter = new Hono();

webhookRouter.post("/stripe/:accountId", async (c) => {
	const accountId = c.req.param("accountId");

	// Verify the account exists
	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, accountId))
		.get();

	if (!account) {
		logger.warn({ accountId }, "Webhook received for unknown account");
		return c.json({ error: "Unknown account" }, 404);
	}

	if (!account.isActive) {
		logger.warn({ accountId }, "Webhook received for inactive account");
		return c.json({ error: "Account inactive" }, 400);
	}

	const rawBody = await c.req.text();
	let event: Stripe.Event;

	// Verify signature if webhook secret is configured
	const webhookSecret = account.webhookSecret ? getWebhookSecret(accountId) : null;

	if (webhookSecret) {
		const signature = c.req.header("stripe-signature");
		if (!signature) {
			return c.json({ error: "Missing stripe-signature header" }, 400);
		}
		try {
			event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			logger.error({ accountId, error: message }, "Webhook signature verification failed");
			return c.json({ error: "Invalid signature" }, 400);
		}
	} else {
		// No webhook secret — parse the event without verification
		try {
			event = JSON.parse(rawBody) as Stripe.Event;
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}
	}

	// Deduplicate by event ID
	const existing = db
		.select({ id: webhookEvents.id })
		.from(webhookEvents)
		.where(
			and(
				eq(webhookEvents.stripeAccountId, accountId),
				eq(webhookEvents.eventId, event.id),
			),
		)
		.get();

	if (existing) {
		logger.debug({ accountId, eventId: event.id }, "Duplicate webhook event, skipping");
		return c.json({ received: true, duplicate: true });
	}

	// Store the event
	db.insert(webhookEvents)
		.values({
			stripeAccountId: accountId,
			eventId: event.id,
			eventType: event.type,
			payload: JSON.stringify(event),
			status: "pending",
		})
		.run();

	// Enqueue a job to process this event
	enqueueJob("process_event", {
		eventId: event.id,
		stripeAccountId: accountId,
	});

	logger.info(
		{ accountId, eventId: event.id, eventType: event.type },
		"Webhook event received and enqueued",
	);

	return c.json({ received: true });
});

export { webhookRouter };
