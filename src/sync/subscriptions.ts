import type Stripe from "stripe";
import { logSync } from "../utils/idempotency.js";
import { logger } from "../utils/logger.js";

// For v1, subscriptions are handled via invoice.paid events.
// Each billing cycle generates an invoice in Stripe, which triggers invoice.paid,
// which creates a regular Zoho invoice + payment. This is simpler and more reliable
// than trying to keep Zoho Recurring Invoices in sync with Stripe subscriptions.

export async function syncSubscriptionEvent(
	stripeAccountId: string,
	eventType: string,
	subscription: Stripe.Subscription,
): Promise<void> {
	const action = eventType.replace("customer.subscription.", "");

	logSync(
		"info",
		`Subscription ${action}: ${subscription.id} (billing handled via invoice events)`,
		stripeAccountId,
		{
			stripeSubscriptionId: subscription.id,
			status: subscription.status,
			customerId:
				typeof subscription.customer === "string"
					? subscription.customer
					: subscription.customer.id,
		},
	);

	logger.info(
		{
			stripeAccountId,
			subscriptionId: subscription.id,
			action,
			status: subscription.status,
		},
		"Subscription event logged (accounting handled via invoice events)",
	);
}
