import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeAccounts } from "../db/schema.js";
import { getStripeClient } from "../clients/stripe.js";
import { zoho } from "../clients/zoho.js";
import { getMapping, createMapping, logSync } from "../utils/idempotency.js";
import { stripeToCurrencyAmount, formatDate } from "../utils/currency.js";
import { logger } from "../utils/logger.js";

export async function syncStripeFees(
	stripeAccountId: string,
	charge: Stripe.Charge,
): Promise<void> {
	if (!charge.balance_transaction) return;

	const balanceTxnId =
		typeof charge.balance_transaction === "string"
			? charge.balance_transaction
			: charge.balance_transaction.id;

	// Check if already synced
	const feeKey = `fee_${balanceTxnId}`;
	const existing = getMapping(stripeAccountId, "fee", feeKey);
	if (existing) return;

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (!account?.zohoClearingAccountId) {
		logger.debug(
			{ chargeId: charge.id },
			"Skipping fee: clearing account not configured",
		);
		return;
	}

	const stripe = getStripeClient(stripeAccountId);
	const balanceTxn = await stripe.balanceTransactions.retrieve(balanceTxnId);

	if (balanceTxn.fee === 0) return;

	const feeAmount = stripeToCurrencyAmount(balanceTxn.fee, balanceTxn.currency);

	const result = await zoho.createExpense({
		...(account.zohoFeeAccountId ? { account_id: account.zohoFeeAccountId } : {}),
		paid_through_account_id: account.zohoClearingAccountId,
		date: formatDate(balanceTxn.created),
		amount: feeAmount,
		reference_number: `stripe_fee_${balanceTxnId}`,
		description: `Stripe processing fee for charge ${charge.id}`,
	});

	createMapping({
		stripeAccountId,
		stripeObjectType: "fee",
		stripeObjectId: feeKey,
		zohoEntityType: "expense",
		zohoEntityId: result.expense.expense_id,
	});

	logSync(
		"info",
		`Created Zoho expense for Stripe fee $${feeAmount} on charge ${charge.id}`,
		stripeAccountId,
		{ stripeChargeId: charge.id, feeAmount },
	);
}

/**
 * Sync standalone Stripe fees (Billing usage fees, Radar, FX fees, tax on fees, etc.)
 * These are separate balance transactions, not part of a charge.
 */
export async function syncStandaloneStripeFee(
	stripeAccountId: string,
	balanceTxn: { id: string; amount: number; currency: string; created: number; description: string | null; type: string },
): Promise<void> {
	const feeKey = `fee_${balanceTxn.id}`;
	const existing = getMapping(stripeAccountId, "fee", feeKey);
	if (existing) return;

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (!account?.zohoClearingAccountId) {
		logger.debug(
			{ txnId: balanceTxn.id },
			"Skipping standalone fee: clearing account not configured",
		);
		return;
	}

	const feeAmount = stripeToCurrencyAmount(Math.abs(balanceTxn.amount), balanceTxn.currency);
	const description = balanceTxn.description || balanceTxn.type.replace(/_/g, " ");

	const result = await zoho.createExpense({
		...(account.zohoFeeAccountId ? { account_id: account.zohoFeeAccountId } : {}),
		paid_through_account_id: account.zohoClearingAccountId,
		date: formatDate(balanceTxn.created),
		amount: feeAmount,
		reference_number: `stripe_fee_${balanceTxn.id}`,
		description,
	});

	createMapping({
		stripeAccountId,
		stripeObjectType: "fee",
		stripeObjectId: feeKey,
		zohoEntityType: "expense",
		zohoEntityId: result.expense.expense_id,
	});

	logSync(
		"info",
		`Synced standalone Stripe fee: ${description} ($${feeAmount})`,
		stripeAccountId,
		{ txnId: balanceTxn.id, feeAmount, description },
	);
}
