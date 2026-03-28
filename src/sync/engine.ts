import type Stripe from "stripe";
import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { webhookEvents } from "../db/schema.js";
import {
	syncCustomerCreated,
	syncCustomerUpdated,
	syncCustomerDeleted,
} from "./customers.js";
import { syncInvoiceFinalized, syncInvoicePaid } from "./invoices.js";
import { syncChargeSucceeded } from "./payments.js";
import { syncRefundCreated } from "./refunds.js";
import { syncSubscriptionEvent } from "./subscriptions.js";
import { syncStripeFees } from "./fees.js";
import { syncPayoutPaid } from "./payouts.js";
import { logSync } from "../utils/idempotency.js";
import { logger } from "../utils/logger.js";

export async function processEvent(
	stripeAccountId: string,
	eventId: string,
): Promise<void> {
	// Load the event from DB
	const eventRow = db
		.select()
		.from(webhookEvents)
		.where(
			and(
				eq(webhookEvents.stripeAccountId, stripeAccountId),
				eq(webhookEvents.eventId, eventId),
			),
		)
		.get();

	if (!eventRow) {
		throw new Error(`Event not found: ${eventId}`);
	}

	// Mark as processing
	db.update(webhookEvents)
		.set({ status: "processing", attempts: eventRow.attempts + 1 })
		.where(eq(webhookEvents.id, eventRow.id))
		.run();

	try {
		const event = JSON.parse(eventRow.payload) as Stripe.Event;
		const object = event.data.object;

		logger.info(
			{ stripeAccountId, eventType: event.type, eventId },
			"Processing event",
		);

		switch (event.type) {
			// Customers
			case "customer.created":
				await syncCustomerCreated(
					stripeAccountId,
					object as Stripe.Customer,
				);
				break;
			case "customer.updated":
				await syncCustomerUpdated(
					stripeAccountId,
					object as Stripe.Customer,
				);
				break;
			case "customer.deleted":
				await syncCustomerDeleted(
					stripeAccountId,
					object as Stripe.Customer,
				);
				break;

			// Invoices
			case "invoice.finalized":
				await syncInvoiceFinalized(
					stripeAccountId,
					object as Stripe.Invoice,
				);
				break;
			case "invoice.paid":
				await syncInvoicePaid(stripeAccountId, object as Stripe.Invoice);
				break;

			// Charges (standalone, non-invoice)
			case "charge.succeeded":
				await syncChargeSucceeded(
					stripeAccountId,
					object as Stripe.Charge,
				);
				// Also record fees
				await syncStripeFees(
					stripeAccountId,
					object as Stripe.Charge,
				);
				break;

			// Refunds
			case "charge.refunded":
			case "refund.created":
				if (event.type === "refund.created") {
					await syncRefundCreated(
						stripeAccountId,
						object as Stripe.Refund,
					);
				}
				break;

			// Subscriptions (for v1, we just let invoice.paid handle the accounting)
			case "customer.subscription.created":
			case "customer.subscription.updated":
			case "customer.subscription.deleted":
				await syncSubscriptionEvent(
					stripeAccountId,
					event.type,
					object as Stripe.Subscription,
				);
				break;

			// Payouts
			case "payout.paid":
				await syncPayoutPaid(
					stripeAccountId,
					object as Stripe.Payout,
				);
				break;

			default:
				logger.debug(
					{ eventType: event.type },
					"Unhandled event type, skipping",
				);
		}

		// Mark as completed
		db.update(webhookEvents)
			.set({ status: "completed", processedAt: new Date().toISOString() })
			.where(eq(webhookEvents.id, eventRow.id))
			.run();
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);

		db.update(webhookEvents)
			.set({ status: "failed", errorMessage })
			.where(eq(webhookEvents.id, eventRow.id))
			.run();

		logSync(
			"error",
			`Failed to process event ${eventId} (${eventRow.eventType}): ${errorMessage}`,
			stripeAccountId,
			{ eventId, eventType: eventRow.eventType },
		);

		throw err; // Re-throw so the worker can retry
	}
}
