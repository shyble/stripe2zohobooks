import type Stripe from "stripe";
import { zoho } from "../clients/zoho.js";
import { getStripeClient } from "../clients/stripe.js";
import { getMapping, createMapping, logSync } from "../utils/idempotency.js";
import { stripeToCurrencyAmount, formatDate } from "../utils/currency.js";
import { logger } from "../utils/logger.js";

export async function syncRefundCreated(
	stripeAccountId: string,
	refund: Stripe.Refund,
): Promise<void> {
	// Check if already synced
	const existing = getMapping(stripeAccountId, "refund", refund.id);
	if (existing) return;

	const chargeId =
		typeof refund.charge === "string" ? refund.charge : refund.charge?.id;

	if (!chargeId) {
		logger.warn({ refundId: refund.id }, "Refund has no charge, skipping");
		return;
	}

	// Find the original charge/invoice mapping to get the customer
	const stripe = getStripeClient(stripeAccountId);
	const charge = await stripe.charges.retrieve(chargeId);

	if (!charge.customer) {
		logger.warn({ refundId: refund.id, chargeId }, "Charge has no customer");
		return;
	}

	const customerId =
		typeof charge.customer === "string"
			? charge.customer
			: charge.customer.id;

	const customerMapping = getMapping(stripeAccountId, "customer", customerId);
	if (!customerMapping) {
		logger.warn({ customerId }, "Customer not mapped in Zoho, skipping refund");
		return;
	}

	const amount = stripeToCurrencyAmount(refund.amount, refund.currency);

	const result = await zoho.createCreditNote({
		customer_id: customerMapping.zohoEntityId,
		creditnote_number: refund.id,
		reference_number: refund.id,
		date: formatDate(refund.created),
		line_items: [
			{
				name: `Refund for charge ${chargeId}`,
				description: refund.reason || "Stripe refund",
				rate: amount,
				quantity: 1,
			},
		],
	});

	const zohoCreditNoteId = result.creditnote.creditnote_id;

	createMapping({
		stripeAccountId,
		stripeObjectType: "refund",
		stripeObjectId: refund.id,
		zohoEntityType: "creditnote",
		zohoEntityId: zohoCreditNoteId,
	});

	// Try to apply credit note to the original invoice
	const invoiceMapping =
		getMapping(stripeAccountId, "invoice", charge.invoice?.toString() || "") ||
		getMapping(stripeAccountId, "charge", chargeId);

	if (invoiceMapping) {
		try {
			await zoho.applyCreditNoteToInvoice(zohoCreditNoteId, [
				{
					invoice_id: invoiceMapping.zohoEntityId,
					amount_applied: amount,
				},
			]);
		} catch (err) {
			logger.warn(
				{ refundId: refund.id, error: err },
				"Could not apply credit note to invoice",
			);
		}
	}

	logSync(
		"info",
		`Created Zoho credit note for Stripe refund ${refund.id}`,
		stripeAccountId,
		{ stripeRefundId: refund.id, zohoCreditNoteId },
	);
}
