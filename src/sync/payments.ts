import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeAccounts } from "../db/schema.js";
import { zoho } from "../clients/zoho.js";
import { getStripeClient } from "../clients/stripe.js";
import { getMapping, createMapping, logSync } from "../utils/idempotency.js";
import { stripeToCurrencyAmount, formatDate } from "../utils/currency.js";
import { ensureCustomerMapped } from "./customers.js";
import { logger } from "../utils/logger.js";

export async function syncChargeSucceeded(
	stripeAccountId: string,
	charge: Stripe.Charge,
): Promise<void> {
	// Skip if this charge is part of an invoice (handled by invoices.ts)
	if (charge.invoice) {
		logger.debug(
			{ chargeId: charge.id },
			"Charge is part of an invoice, skipping standalone payment",
		);
		return;
	}

	// Check if already synced
	const existing = getMapping(stripeAccountId, "charge", charge.id);
	if (existing) return;

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (!account?.zohoClearingAccountId) {
		logger.warn({ chargeId: charge.id }, "Clearing account not configured, skipping charge sync");
		return;
	}

	const amount = stripeToCurrencyAmount(charge.amount, charge.currency);

	const result = await zoho.createBankTransaction({
		to_account_id: account.zohoClearingAccountId,
		transaction_type: "sales_without_invoices",
		amount,
		date: formatDate(charge.created),
		reference_number: charge.id,
		description: charge.description || `Stripe charge ${charge.id}`,
	});

	createMapping({
		stripeAccountId,
		stripeObjectType: "charge",
		stripeObjectId: charge.id,
		zohoEntityType: "banktransaction",
		zohoEntityId: result.banktransaction.transaction_id,
	});

	logSync(
		"info",
		`Created Zoho bank transaction (sales without invoice) for Stripe charge ${charge.id}`,
		stripeAccountId,
		{ stripeChargeId: charge.id, zohoTransactionId: result.banktransaction.transaction_id },
	);
}
