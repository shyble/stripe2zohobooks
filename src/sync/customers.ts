import type Stripe from "stripe";
import { zoho } from "../clients/zoho.js";
import { getMapping, createMapping, logSync } from "../utils/idempotency.js";
import { logger } from "../utils/logger.js";

export async function syncCustomerCreated(
	stripeAccountId: string,
	customer: Stripe.Customer,
): Promise<string> {
	// Check if already synced
	const existing = getMapping(stripeAccountId, "customer", customer.id);
	if (existing) {
		logger.debug({ customerId: customer.id }, "Customer already mapped");
		return existing.zohoEntityId;
	}

	const contactName =
		customer.name || customer.email || customer.id;

	const result = await zoho.createContact({
		contact_name: contactName,
		email: customer.email ?? undefined,
		company_name: customer.name ?? undefined,
		contact_type: "customer",
		notes: `Synced from Stripe account ${stripeAccountId}. Stripe ID: ${customer.id}`,
	});

	const zohoContactId = result.contact.contact_id;

	createMapping({
		stripeAccountId,
		stripeObjectType: "customer",
		stripeObjectId: customer.id,
		zohoEntityType: "contact",
		zohoEntityId: zohoContactId,
	});

	logSync(
		"info",
		`Created Zoho contact "${contactName}" for Stripe customer ${customer.id}`,
		stripeAccountId,
		{ stripeCustomerId: customer.id, zohoContactId },
	);

	return zohoContactId;
}

export async function syncCustomerUpdated(
	stripeAccountId: string,
	customer: Stripe.Customer,
): Promise<void> {
	const mapping = getMapping(stripeAccountId, "customer", customer.id);

	if (!mapping) {
		// Customer doesn't exist in Zoho yet, create it
		await syncCustomerCreated(stripeAccountId, customer);
		return;
	}

	const contactName =
		customer.name || customer.email || customer.id;

	await zoho.updateContact(mapping.zohoEntityId, {
		contact_name: contactName,
		email: customer.email ?? undefined,
		company_name: customer.name ?? undefined,
	});

	logSync(
		"info",
		`Updated Zoho contact for Stripe customer ${customer.id}`,
		stripeAccountId,
		{ stripeCustomerId: customer.id, zohoContactId: mapping.zohoEntityId },
	);
}

export async function syncCustomerDeleted(
	stripeAccountId: string,
	customer: Stripe.Customer,
): Promise<void> {
	const mapping = getMapping(stripeAccountId, "customer", customer.id);
	if (!mapping) return;

	await zoho.markContactInactive(mapping.zohoEntityId);

	logSync(
		"info",
		`Marked Zoho contact inactive for deleted Stripe customer ${customer.id}`,
		stripeAccountId,
		{ stripeCustomerId: customer.id, zohoContactId: mapping.zohoEntityId },
	);
}

export async function ensureCustomerMapped(
	stripeAccountId: string,
	customer: Stripe.Customer,
): Promise<string> {
	const existing = getMapping(stripeAccountId, "customer", customer.id);
	if (existing) return existing.zohoEntityId;
	return syncCustomerCreated(stripeAccountId, customer);
}
