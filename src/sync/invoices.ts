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

export async function syncInvoiceFinalized(
	stripeAccountId: string,
	invoice: Stripe.Invoice,
): Promise<void> {
	// No-op: invoices are synced as bank transactions when paid
	logger.debug({ invoiceId: invoice.id }, "Invoice finalized — will sync as bank transaction on payment");
}

export async function syncInvoicePaid(
	stripeAccountId: string,
	invoice: Stripe.Invoice,
): Promise<void> {
	// Check if already synced
	const existing = getMapping(stripeAccountId, "invoice", invoice.id);
	if (existing) {
		logger.debug({ invoiceId: invoice.id }, "Invoice already mapped");
		return;
	}

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (!account?.zohoClearingAccountId) {
		logger.warn({ invoiceId: invoice.id }, "Clearing account not configured, skipping invoice sync");
		return;
	}

	const amount = stripeToCurrencyAmount(invoice.amount_paid, invoice.currency);
	const date = formatDate(invoice.status_transitions?.paid_at || invoice.created || Math.floor(Date.now() / 1000));

	const result = await zoho.createBankTransaction({
		to_account_id: account.zohoClearingAccountId,
		transaction_type: "sales_without_invoices",
		amount,
		date,
		reference_number: invoice.id,
		description: `Stripe invoice ${invoice.number || invoice.id}`,
	});

	const txnId = result.banktransaction.transaction_id;

	createMapping({
		stripeAccountId,
		stripeObjectType: "invoice",
		stripeObjectId: invoice.id,
		zohoEntityType: "banktransaction",
		zohoEntityId: txnId,
	});

	logSync(
		"info",
		`Created Zoho bank transaction (sales without invoice) for Stripe invoice ${invoice.number || invoice.id}`,
		stripeAccountId,
		{ stripeInvoiceId: invoice.id, zohoTransactionId: txnId },
	);
}
