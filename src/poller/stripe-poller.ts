import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeAccounts, webhookEvents } from "../db/schema.js";
import { getStripeClient } from "../clients/stripe.js";
import { enqueueJob } from "../queue/scheduler.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Track the last polled event timestamp per account
const lastPollTime = new Map<string, number>();

let running = false;

async function pollAccount(accountId: string, apiKey: string): Promise<number> {
	const stripe = getStripeClient(accountId);
	const since = lastPollTime.get(accountId) || Math.floor(Date.now() / 1000) - 86400; // Default: last 24h on first run

	let newEvents = 0;

	try {
		const events = await stripe.events.list({
			created: { gt: since },
			limit: 100,
		});

		for (const event of events.data) {
			// Deduplicate
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

			if (existing) continue;

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

			// Enqueue for processing
			enqueueJob("process_event", {
				eventId: event.id,
				stripeAccountId: accountId,
			});

			newEvents++;
		}

		// Update last poll time to the most recent event or now
		if (events.data.length > 0) {
			lastPollTime.set(accountId, events.data[0].created);
		} else {
			lastPollTime.set(accountId, Math.floor(Date.now() / 1000));
		}
	} catch (err) {
		logger.error(
			{ accountId, error: err instanceof Error ? err.message : err },
			"Failed to poll Stripe events",
		);
	}

	return newEvents;
}

async function pollAllAccounts(): Promise<void> {
	const accounts = db
		.select()
		.from(stripeAccounts)
		.all()
		.filter((a) => a.isActive);

	if (accounts.length === 0) return;

	for (const account of accounts) {
		const newEvents = await pollAccount(account.stripeAccountId, account.apiKey);
		if (newEvents > 0) {
			logger.info(
				{ accountId: account.stripeAccountId, newEvents },
				"Polled new Stripe events",
			);
		}
	}
}

export function startPoller(): void {
	if (running) return;
	running = true;

	const intervalMs = config.pollIntervalSeconds * 1000;

	logger.info(
		{ intervalSeconds: config.pollIntervalSeconds },
		"Stripe event poller started",
	);

	const poll = async () => {
		if (!running) return;

		try {
			await pollAllAccounts();
		} catch (err) {
			logger.error({ error: err }, "Poller error");
		}

		setTimeout(poll, intervalMs);
	};

	// Start first poll after a short delay to let the server initialize
	setTimeout(poll, 2000);
}

export function stopPoller(): void {
	running = false;
	logger.info("Stripe event poller stopped");
}
