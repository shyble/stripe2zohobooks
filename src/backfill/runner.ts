import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeAccounts } from "../db/schema.js";
import { getStripeClient } from "../clients/stripe.js";
import { getMapping, deleteMapping, logSync } from "../utils/idempotency.js";
import { syncCustomerCreated } from "../sync/customers.js";
import { syncInvoicePaid } from "../sync/invoices.js";
import { syncChargeSucceeded } from "../sync/payments.js";
import { syncRefundCreated } from "../sync/refunds.js";
import { syncStripeFees, syncStandaloneStripeFee } from "../sync/fees.js";
import { syncPayoutPaid } from "../sync/payouts.js";
import { stripeToCurrencyAmount } from "../utils/currency.js";
import { zoho } from "../clients/zoho.js";
import { logger } from "../utils/logger.js";
import type Stripe from "stripe";

type SyncStatus = "new" | "synced" | "exists_in_zoho";

export interface BackfillPreview {
	customers: Array<{ id: string; name: string; email: string | null; status: SyncStatus }>;
	invoices: Array<{ id: string; number: string | null; amount: number; currency: string; date: string; customer: string; status: SyncStatus; zohoId?: string; zohoTxnType?: string }>;
	charges: Array<{ id: string; amount: number; currency: string; date: string; description: string | null; customer: string; status: SyncStatus; zohoId?: string; zohoTxnType?: string }>;
	fees: Array<{ id: string; amount: number; currency: string; date: string; description: string; source: string; status: SyncStatus; zohoId?: string; zohoTxnType?: string }>;
	refunds: Array<{ id: string; amount: number; currency: string; date: string; chargeId: string; status: SyncStatus }>;
	payouts: Array<{ id: string; amount: number; currency: string; date: string; status: SyncStatus; zohoId?: string; zohoTxnType?: string }>;
	totals: {
		customers: number;
		invoices: number;
		charges: number;
		fees: number;
		refunds: number;
		payouts: number;
		alreadySynced: number;
		existsInZoho: number;
		toSync: number;
	};
}

export async function previewBackfill(
	stripeAccountId: string,
	dateFrom?: string,
	dateTo?: string,
): Promise<BackfillPreview> {
	const stripe = getStripeClient(stripeAccountId);

	const created: Stripe.RangeQueryParam = {};
	if (dateFrom) created.gte = Math.floor(new Date(dateFrom).getTime() / 1000);
	if (dateTo) created.lte = Math.floor(new Date(dateTo + "T23:59:59Z").getTime() / 1000);

	const preview: BackfillPreview = {
		customers: [],
		invoices: [],
		charges: [],
		fees: [],
		refunds: [],
		payouts: [],
		totals: { customers: 0, invoices: 0, charges: 0, fees: 0, refunds: 0, payouts: 0, alreadySynced: 0, existsInZoho: 0, toSync: 0 },
	};

	// Load existing Zoho data for duplicate detection
	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	// Pre-fetch Zoho bank transactions on the clearing account for matching
	let zohoBankTxns: Array<{ transaction_id: string; date: string; amount: number; reference_number: string; description: string; transaction_type: string }> = [];
	if (account?.zohoClearingAccountId) {
		try {
			const result = await zoho.listBankTransactionsByAccount(
				account.zohoClearingAccountId,
				dateFrom,
				dateTo,
			);
			zohoBankTxns = result.banktransactions || [];
			logger.info({ count: zohoBankTxns.length }, "Loaded Zoho bank transactions for duplicate check");
			if (zohoBankTxns.length > 0) {
				logger.debug({ sample: { date: zohoBankTxns[0].date, amount: zohoBankTxns[0].amount, ref: zohoBankTxns[0].reference_number, desc: zohoBankTxns[0].description } }, "Sample Zoho bank transaction");
			}
		} catch (err) {
			logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Could not fetch Zoho bank transactions for duplicate check");
		}
	}

	// Pre-fetch Zoho invoices for matching
	let zohoInvoices: Array<{ invoice_id: string; date: string; total: number; reference_number: string; customer_name: string }> = [];
	try {
		const result = await zoho.listInvoices(dateFrom, dateTo);
		zohoInvoices = result.invoices || [];
		logger.info({ count: zohoInvoices.length }, "Loaded Zoho invoices for duplicate check");
		if (zohoInvoices.length > 0) {
			logger.info({
				sample: {
					date: zohoInvoices[0].date,
					total: zohoInvoices[0].total,
					totalType: typeof zohoInvoices[0].total,
					ref: zohoInvoices[0].reference_number,
					customer: zohoInvoices[0].customer_name,
				},
			}, "Sample Zoho invoice");
		}
	} catch (err) {
		logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Could not fetch Zoho invoices for duplicate check");
	}
	const matchedZohoInvoices = new Set<string>();

	function findZohoInvoiceDuplicate(refNumber: string, date: string, amount: number): { id: string; txnType: string } | undefined {
		// 1. Exact reference number match
		const exactMatch = zohoInvoices.find((inv) =>
			!matchedZohoInvoices.has(inv.invoice_id) && inv.reference_number === refNumber
		);
		if (exactMatch) {
			matchedZohoInvoices.add(exactMatch.invoice_id);
			return { id: exactMatch.invoice_id, txnType: "invoice" };
		}

		// 2. Date + amount match (for manually created invoices)
		const amountMatch = zohoInvoices.find((inv) =>
			!matchedZohoInvoices.has(inv.invoice_id) &&
			inv.date === date &&
			Math.abs(inv.total - amount) < 0.01
		);
		if (amountMatch) {
			matchedZohoInvoices.add(amountMatch.invoice_id);
			return { id: amountMatch.invoice_id, txnType: "invoice" };
		}

		return undefined;
	}

	// Helper: check if a transaction exists in Zoho by reference, date, and amount
	// Tracks which Zoho transactions have already been matched to avoid double-matching
	const matchedZohoTxns = new Set<string>();

	function findZohoDuplicate(refNumber: string, date: string, amount: number): { id: string; txnType: string } | undefined {
		// 1. Exact reference number match
		const exactMatch = zohoBankTxns.find((t) =>
			!matchedZohoTxns.has(t.transaction_id) && t.reference_number === refNumber
		);
		if (exactMatch) {
			matchedZohoTxns.add(exactMatch.transaction_id);
			return { id: exactMatch.transaction_id, txnType: exactMatch.transaction_type };
		}

		// 2. Reference contains Stripe ID or description contains it
		const refMatch = zohoBankTxns.find((t) =>
			!matchedZohoTxns.has(t.transaction_id) &&
			t.date === date &&
			Math.abs(t.amount - amount) < 0.01 &&
			((t.reference_number || "").includes(refNumber.substring(0, 10)) ||
			 (t.description || "").includes(refNumber.substring(0, 10)))
		);
		if (refMatch) {
			matchedZohoTxns.add(refMatch.transaction_id);
			return { id: refMatch.transaction_id, txnType: refMatch.transaction_type };
		}

		// 3. Date + amount match (for manually entered records without Stripe IDs)
		const amountMatch = zohoBankTxns.find((t) =>
			!matchedZohoTxns.has(t.transaction_id) &&
			t.date === date &&
			Math.abs(t.amount - amount) < 0.01
		);
		if (amountMatch) {
			matchedZohoTxns.add(amountMatch.transaction_id);
			return { id: amountMatch.transaction_id, txnType: amountMatch.transaction_type };
		}

		return undefined;
	}

	// Verify a mapping still exists in Zoho; if not, delete the stale mapping
	function verifyMapping(mapping: { zohoEntityType: string; zohoEntityId: string }, stripeObjectType: string, stripeObjectId: string): boolean {
		const id = mapping.zohoEntityId;
		const existsInZoho =
			zohoInvoices.some((inv) => inv.invoice_id === id) ||
			zohoBankTxns.some((t) => t.transaction_id === id);
		if (!existsInZoho) {
			logger.info({ stripeObjectType, stripeObjectId, zohoEntityId: id }, "Mapped Zoho entity not found, removing stale mapping");
			deleteMapping(stripeAccountId, stripeObjectType, stripeObjectId);
			return false;
		}
		return true;
	}

	const createdFilter = Object.keys(created).length ? created : undefined;

	// Customers
	for await (const customer of stripe.customers.list({ limit: 100, created: createdFilter })) {
		let status: SyncStatus = "new";
		if (getMapping(stripeAccountId, "customer", customer.id)) {
			status = "synced";
		} else if (customer.email) {
			try {
				const result = await zoho.searchContacts(customer.email);
				if (result.contacts?.length > 0) status = "exists_in_zoho";
			} catch { /* ignore */ }
		}
		preview.customers.push({
			id: customer.id,
			name: customer.name || customer.id,
			email: customer.email,
			status,
		});
		await sleep(100);
	}

	// Paid invoices
	for await (const invoice of stripe.invoices.list({ limit: 100, status: "paid", created: createdFilter })) {
		let status: SyncStatus = "new";
		let zohoId: string | undefined;
		let zohoTxnType: string | undefined;
		const invoiceMapping = getMapping(stripeAccountId, "invoice", invoice.id);
		if (invoiceMapping && verifyMapping(invoiceMapping, "invoice", invoice.id)) {
			status = "synced";
		} else {
			const amount = stripeToCurrencyAmount(invoice.amount_paid, invoice.currency);
			const date = new Date((invoice.created || 0) * 1000).toISOString().split("T")[0];
			logger.debug({ stripeInvoice: invoice.id, stripeDate: date, stripeAmount: amount }, "Comparing Stripe invoice");
			const dup = findZohoInvoiceDuplicate(invoice.id, date, amount)
				|| findZohoDuplicate(invoice.id, date, amount);
			if (dup) {
				status = "exists_in_zoho";
				zohoId = dup.id;
				zohoTxnType = dup.txnType;
			}
		}
		const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id || "";
		preview.invoices.push({
			id: invoice.id,
			number: invoice.number,
			amount: stripeToCurrencyAmount(invoice.amount_paid, invoice.currency),
			currency: invoice.currency.toUpperCase(),
			date: new Date((invoice.created || 0) * 1000).toISOString().split("T")[0],
			customer: customerId,
			status,
			zohoId,
			zohoTxnType,
		});
		await sleep(100);
	}

	// Standalone charges
	for await (const charge of stripe.charges.list({ limit: 100, created: createdFilter })) {
		if (charge.invoice) continue;
		if (!charge.paid) continue;
		let status: SyncStatus = "new";
		let zohoId: string | undefined;
		let zohoTxnType: string | undefined;
		const chargeMapping = getMapping(stripeAccountId, "charge", charge.id);
		if (chargeMapping && verifyMapping(chargeMapping, "charge", charge.id)) {
			status = "synced";
		} else {
			const dup = findZohoDuplicate(
				charge.id,
				new Date(charge.created * 1000).toISOString().split("T")[0],
				stripeToCurrencyAmount(charge.amount, charge.currency),
			);
			if (dup) { status = "exists_in_zoho"; zohoId = dup.id; zohoTxnType = dup.txnType; }
		}
		const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id || "";
		preview.charges.push({
			id: charge.id,
			amount: stripeToCurrencyAmount(charge.amount, charge.currency),
			currency: charge.currency.toUpperCase(),
			date: new Date(charge.created * 1000).toISOString().split("T")[0],
			description: charge.description,
			customer: customerId,
			status,
			zohoId,
			zohoTxnType,
		});
		await sleep(100);
	}

	// Fees from charge balance transactions (processing fees)
	for await (const charge of stripe.charges.list({ limit: 100, created: createdFilter, expand: ["data.balance_transaction"] })) {
		if (!charge.paid || !charge.balance_transaction) continue;
		const balanceTxn = typeof charge.balance_transaction === "string" ? null : charge.balance_transaction;
		if (!balanceTxn || balanceTxn.fee === 0) continue;
		const feeKey = `fee_${balanceTxn.id}`;
		let status: SyncStatus = "new";
		let zohoId: string | undefined;
		let zohoTxnType: string | undefined;
		const feeMapping1 = getMapping(stripeAccountId, "fee", feeKey);
		if (feeMapping1 && verifyMapping(feeMapping1, "fee", feeKey)) {
			status = "synced";
		} else {
			const dup = findZohoDuplicate(
				`stripe_fee_${balanceTxn.id}`,
				new Date(balanceTxn.created * 1000).toISOString().split("T")[0],
				stripeToCurrencyAmount(balanceTxn.fee, balanceTxn.currency),
			);
			if (dup) { status = "exists_in_zoho"; zohoId = dup.id; zohoTxnType = dup.txnType; }
		}
		preview.fees.push({
			id: balanceTxn.id,
			amount: stripeToCurrencyAmount(balanceTxn.fee, balanceTxn.currency),
			currency: balanceTxn.currency.toUpperCase(),
			date: new Date(balanceTxn.created * 1000).toISOString().split("T")[0],
			description: "Processing fee",
			source: charge.id,
			status,
			zohoId,
			zohoTxnType,
		});
		await sleep(100);
	}

	// Standalone Stripe fees (Billing usage, Radar, Identity, etc.)
	for (const feeType of ["stripe_fee", "stripe_fx_fee", "tax_fee"] as const) {
		for await (const txn of stripe.balanceTransactions.list({ limit: 100, type: feeType, created: createdFilter })) {
			const feeKey = `fee_${txn.id}`;
			let status: SyncStatus = "new";
			let zohoId: string | undefined;
			let zohoTxnType: string | undefined;
			const feeMapping2 = getMapping(stripeAccountId, "fee", feeKey);
			if (feeMapping2 && verifyMapping(feeMapping2, "fee", feeKey)) {
				status = "synced";
			} else {
				const amount = stripeToCurrencyAmount(Math.abs(txn.amount), txn.currency);
				const date = new Date(txn.created * 1000).toISOString().split("T")[0];
				const dup = findZohoDuplicate(`stripe_fee_${txn.id}`, date, amount);
				if (dup) { status = "exists_in_zoho"; zohoId = dup.id; zohoTxnType = dup.txnType; }
			}
			preview.fees.push({
				id: txn.id,
				amount: stripeToCurrencyAmount(Math.abs(txn.amount), txn.currency),
				currency: txn.currency.toUpperCase(),
				date: new Date(txn.created * 1000).toISOString().split("T")[0],
				description: txn.description || feeType.replace(/_/g, " "),
				source: feeType,
				status,
				zohoId,
				zohoTxnType,
			});
			await sleep(100);
		}
	}

	// Refunds
	for await (const refund of stripe.refunds.list({ limit: 100, created: createdFilter })) {
		let status: SyncStatus = "new";
		const refundMapping = getMapping(stripeAccountId, "refund", refund.id);
		if (refundMapping && verifyMapping(refundMapping, "refund", refund.id)) {
			status = "synced";
		} else {
			const dup = findZohoDuplicate(
				refund.id,
				new Date(refund.created * 1000).toISOString().split("T")[0],
				stripeToCurrencyAmount(refund.amount, refund.currency),
			);
			if (dup) status = "exists_in_zoho";
		}
		const chargeId = typeof refund.charge === "string" ? refund.charge : refund.charge?.id || "";
		preview.refunds.push({
			id: refund.id,
			amount: stripeToCurrencyAmount(refund.amount, refund.currency),
			currency: refund.currency.toUpperCase(),
			date: new Date(refund.created * 1000).toISOString().split("T")[0],
			chargeId,
			status,
		});
		await sleep(100);
	}

	// Payouts
	for await (const payout of stripe.payouts.list({ limit: 100, created: createdFilter })) {
		if (payout.status !== "paid") continue;
		let status: SyncStatus = "new";
		let zohoId: string | undefined;
		let zohoTxnType: string | undefined;
		const payoutMapping = getMapping(stripeAccountId, "payout", payout.id);
		if (payoutMapping && verifyMapping(payoutMapping, "payout", payout.id)) {
			status = "synced";
		} else {
			const dup = findZohoDuplicate(
				payout.id,
				new Date(payout.arrival_date * 1000).toISOString().split("T")[0],
				stripeToCurrencyAmount(payout.amount, payout.currency),
			);
			if (dup) { status = "exists_in_zoho"; zohoId = dup.id; zohoTxnType = dup.txnType; }
		}
		preview.payouts.push({
			id: payout.id,
			amount: stripeToCurrencyAmount(payout.amount, payout.currency),
			currency: payout.currency.toUpperCase(),
			date: new Date(payout.arrival_date * 1000).toISOString().split("T")[0],
			status,
			zohoId,
			zohoTxnType,
		});
		await sleep(100);
	}

	let alreadySynced = 0;
	let existsInZoho = 0;
	for (const list of [preview.customers, preview.invoices, preview.charges, preview.fees, preview.refunds, preview.payouts]) {
		for (const item of list) {
			const s = (item as { status: SyncStatus }).status;
			if (s === "synced") alreadySynced++;
			if (s === "exists_in_zoho") existsInZoho++;
		}
	}

	const total = preview.customers.length + preview.invoices.length + preview.charges.length + preview.fees.length + preview.refunds.length + preview.payouts.length;

	preview.totals = {
		customers: preview.customers.length,
		invoices: preview.invoices.length,
		charges: preview.charges.length,
		fees: preview.fees.length,
		refunds: preview.refunds.length,
		payouts: preview.payouts.length,
		alreadySynced,
		existsInZoho,
		toSync: total - alreadySynced - existsInZoho,
	};

	return preview;
}

export async function runBackfill(
	stripeAccountId: string,
	dateFrom?: string,
	dateTo?: string,
): Promise<void> {
	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, stripeAccountId))
		.get();

	if (!account) {
		throw new Error(`Stripe account not found: ${stripeAccountId}`);
	}

	const stripe = getStripeClient(stripeAccountId);

	const created: Stripe.RangeQueryParam = {};
	if (dateFrom) created.gte = Math.floor(new Date(dateFrom).getTime() / 1000);
	if (dateTo) created.lte = Math.floor(new Date(dateTo + "T23:59:59Z").getTime() / 1000);
	const createdParam = Object.keys(created).length ? created : undefined;

	logSync("info", `Starting backfill${dateFrom ? ` from ${dateFrom}` : ""}${dateTo ? ` to ${dateTo}` : ""}`, stripeAccountId);
	logger.info({ stripeAccountId, dateFrom, dateTo }, "Starting backfill");

	// Pre-fetch Zoho data for duplicate detection (same as preview)
	let zohoBankTxns: Array<{ transaction_id: string; date: string; amount: number; reference_number: string; description: string; transaction_type: string }> = [];
	if (account.zohoClearingAccountId) {
		try {
			const result = await zoho.listBankTransactionsByAccount(account.zohoClearingAccountId, dateFrom, dateTo);
			zohoBankTxns = result.banktransactions || [];
			logger.info({ count: zohoBankTxns.length }, "Backfill: loaded Zoho bank transactions for duplicate check");
		} catch (err) {
			logger.warn({ error: err instanceof Error ? err.message : String(err) }, "Backfill: could not fetch Zoho bank transactions");
		}
	}

	const matchedZohoTxns = new Set<string>();
	function isDuplicateInZoho(refNumber: string, date: string, amount: number): boolean {
		const match = zohoBankTxns.find((t) =>
			!matchedZohoTxns.has(t.transaction_id) && (
				t.reference_number === refNumber ||
				(t.date === date && Math.abs(t.amount - amount) < 0.01)
			)
		);
		if (match) {
			matchedZohoTxns.add(match.transaction_id);
			logger.info({ stripeRef: refNumber, zohoTxnId: match.transaction_id }, "Backfill: skipping — already exists in Zoho");
			return true;
		}
		return false;
	}

	// 1. Customers
	let customerCount = 0;
	for await (const customer of stripe.customers.list({ limit: 100, created: createdParam })) {
		if (getMapping(stripeAccountId, "customer", customer.id)) continue;
		try {
			await syncCustomerCreated(stripeAccountId, customer);
			customerCount++;
		} catch (err) {
			logger.error({ customerId: customer.id, error: err }, "Backfill: failed to sync customer");
		}
		await sleep(1000);
	}
	logger.info({ stripeAccountId, customerCount }, "Backfill: customers done");

	// 2. Paid invoices
	let invoiceCount = 0;
	let invoiceSkipped = 0;
	for await (const invoice of stripe.invoices.list({ limit: 100, status: "paid", created: createdParam })) {
		if (getMapping(stripeAccountId, "invoice", invoice.id)) continue;
		const amount = stripeToCurrencyAmount(invoice.amount_paid, invoice.currency);
		const date = new Date((invoice.created || 0) * 1000).toISOString().split("T")[0];
		if (isDuplicateInZoho(invoice.id, date, amount)) { invoiceSkipped++; continue; }
		try {
			await syncInvoicePaid(stripeAccountId, invoice);
			invoiceCount++;
		} catch (err) {
			logger.error({ invoiceId: invoice.id, error: err }, "Backfill: failed to sync invoice");
		}
		await sleep(1000);
	}
	logger.info({ stripeAccountId, invoiceCount, invoiceSkipped }, "Backfill: invoices done");

	// 3. Standalone charges + fees
	let chargeCount = 0;
	let chargeSkipped = 0;
	for await (const charge of stripe.charges.list({ limit: 100, created: createdParam })) {
		if (charge.invoice) continue;
		if (!charge.paid) continue;
		if (getMapping(stripeAccountId, "charge", charge.id)) continue;
		const amount = stripeToCurrencyAmount(charge.amount, charge.currency);
		const date = new Date(charge.created * 1000).toISOString().split("T")[0];
		if (isDuplicateInZoho(charge.id, date, amount)) { chargeSkipped++; continue; }
		try {
			await syncChargeSucceeded(stripeAccountId, charge);
			await syncStripeFees(stripeAccountId, charge);
			chargeCount++;
		} catch (err) {
			logger.error({ chargeId: charge.id, error: err }, "Backfill: failed to sync charge");
		}
		await sleep(1000);
	}
	logger.info({ stripeAccountId, chargeCount, chargeSkipped }, "Backfill: charges done");

	// 4. Fees for invoice-based charges
	let feeCount = 0;
	let feeSkipped = 0;
	for await (const charge of stripe.charges.list({ limit: 100, created: createdParam, expand: ["data.balance_transaction"] })) {
		if (!charge.invoice) continue;
		if (!charge.paid) continue;
		const balanceTxn = typeof charge.balance_transaction === "string" ? null : charge.balance_transaction;
		if (!balanceTxn || balanceTxn.fee === 0) continue;
		const feeKey = `fee_${balanceTxn.id}`;
		if (getMapping(stripeAccountId, "fee", feeKey)) continue;
		const feeAmount = stripeToCurrencyAmount(balanceTxn.fee, balanceTxn.currency);
		const feeDate = new Date(balanceTxn.created * 1000).toISOString().split("T")[0];
		if (isDuplicateInZoho(`stripe_fee_${balanceTxn.id}`, feeDate, feeAmount)) { feeSkipped++; continue; }
		try {
			await syncStripeFees(stripeAccountId, charge);
			feeCount++;
		} catch (err) {
			logger.error({ chargeId: charge.id, error: err }, "Backfill: failed to sync fee");
		}
		await sleep(1000);
	}
	// 4b. Standalone Stripe fees (Billing usage, Radar, FX, tax on fees)
	for (const feeType of ["stripe_fee", "stripe_fx_fee", "tax_fee"] as const) {
		for await (const txn of stripe.balanceTransactions.list({ limit: 100, type: feeType, created: createdParam })) {
			const feeKey = `fee_${txn.id}`;
			if (getMapping(stripeAccountId, "fee", feeKey)) continue;
			const amount = stripeToCurrencyAmount(Math.abs(txn.amount), txn.currency);
			const date = new Date(txn.created * 1000).toISOString().split("T")[0];
			if (isDuplicateInZoho(`stripe_fee_${txn.id}`, date, amount)) { feeSkipped++; continue; }
			try {
				await syncStandaloneStripeFee(stripeAccountId, txn);
				feeCount++;
			} catch (err) {
				logger.error({ txnId: txn.id, error: err }, "Backfill: failed to sync standalone fee");
			}
			await sleep(1000);
		}
	}
	logger.info({ stripeAccountId, feeCount, feeSkipped }, "Backfill: fees done");

	// 5. Refunds
	let refundCount = 0;
	for await (const refund of stripe.refunds.list({ limit: 100, created: createdParam })) {
		if (getMapping(stripeAccountId, "refund", refund.id)) continue;
		try {
			await syncRefundCreated(stripeAccountId, refund);
			refundCount++;
		} catch (err) {
			logger.error({ refundId: refund.id, error: err }, "Backfill: failed to sync refund");
		}
		await sleep(1000);
	}
	logger.info({ stripeAccountId, refundCount }, "Backfill: refunds done");

	// 6. Payouts
	let payoutCount = 0;
	let payoutSkipped = 0;
	for await (const payout of stripe.payouts.list({ limit: 100, created: createdParam })) {
		if (payout.status !== "paid") continue;
		if (getMapping(stripeAccountId, "payout", payout.id)) continue;
		const amount = stripeToCurrencyAmount(payout.amount, payout.currency);
		const date = new Date(payout.arrival_date * 1000).toISOString().split("T")[0];
		if (isDuplicateInZoho(payout.id, date, amount)) { payoutSkipped++; continue; }
		try {
			await syncPayoutPaid(stripeAccountId, payout);
			payoutCount++;
		} catch (err) {
			logger.error({ payoutId: payout.id, error: err }, "Backfill: failed to sync payout");
		}
		await sleep(1000);
	}
	logger.info({ stripeAccountId, payoutCount, payoutSkipped }, "Backfill: payouts done");

	const summary = `Backfill complete: ${customerCount} customers, ${invoiceCount} invoices (${invoiceSkipped} skipped), ${chargeCount} charges (${chargeSkipped} skipped), ${feeCount} fees (${feeSkipped} skipped), ${refundCount} refunds, ${payoutCount} payouts (${payoutSkipped} skipped)`;
	logSync("info", summary, stripeAccountId);
	logger.info({ stripeAccountId }, summary);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
