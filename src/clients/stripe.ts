import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { stripeAccounts } from "../db/schema.js";
import { decrypt } from "../utils/crypto.js";

const clientCache = new Map<string, Stripe>();

export function getStripeClient(accountId: string): Stripe {
	const cached = clientCache.get(accountId);
	if (cached) return cached;

	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, accountId))
		.get();

	if (!account) {
		throw new Error(`Stripe account not found: ${accountId}`);
	}

	if (!account.isActive) {
		throw new Error(`Stripe account is inactive: ${accountId}`);
	}

	const client = new Stripe(decrypt(account.apiKey), {
		apiVersion: "2025-02-24.acacia",
	});

	clientCache.set(accountId, client);
	return client;
}

export function getWebhookSecret(accountId: string): string | null {
	const account = db
		.select()
		.from(stripeAccounts)
		.where(eq(stripeAccounts.stripeAccountId, accountId))
		.get();

	if (!account) {
		throw new Error(`Stripe account not found: ${accountId}`);
	}

	return account.webhookSecret ? decrypt(account.webhookSecret) : null;
}

export function clearClientCache(accountId?: string) {
	if (accountId) {
		clientCache.delete(accountId);
	} else {
		clientCache.clear();
	}
}
