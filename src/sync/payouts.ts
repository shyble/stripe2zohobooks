import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeAccounts } from "../db/schema.js";
import { zoho } from "../clients/zoho.js";
import { getMapping, createMapping, logSync } from "../utils/idempotency.js";
import { stripeToCurrencyAmount, formatDate } from "../utils/currency.js";
import { logger } from "../utils/logger.js";

export async function syncPayoutPaid(
	stripeAccountId: string,
	payout: Stripe.Payout,
): Promise<void> {
	// Check if already synced
	const existing = getMapping(stripeAccountId, "payout", payout.id);
	if (existing) return;

	// Check if Zoho account IDs are configured on this Stripe account
	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (!account?.zohoClearingAccountId || !account?.zohoBankAccountId) {
		logger.debug(
			{ payoutId: payout.id },
			"Skipping payout sync: Zoho account IDs not configured on this Stripe account",
		);
		return;
	}

	const amount = stripeToCurrencyAmount(payout.amount, payout.currency);

	const result = await zoho.createBankTransaction({
		from_account_id: account.zohoClearingAccountId,
		to_account_id: account.zohoBankAccountId,
		transaction_type: "transfer_fund",
		amount,
		date: formatDate(payout.arrival_date),
		reference_number: payout.id,
		description: `Stripe payout ${payout.id} from account ${stripeAccountId}`,
	});

	createMapping({
		stripeAccountId,
		stripeObjectType: "payout",
		stripeObjectId: payout.id,
		zohoEntityType: "banktransaction",
		zohoEntityId: result.banktransaction.transaction_id,
	});

	logSync(
		"info",
		`Created bank transaction for Stripe payout ${payout.id} ($${amount})`,
		stripeAccountId,
		{ stripePayoutId: payout.id, amount },
	);
}
