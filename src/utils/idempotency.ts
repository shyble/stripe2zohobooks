import { eq, and } from "drizzle-orm";
import { db } from "../db/connection.js";
import { syncMappings, syncLog } from "../db/schema.js";

export function getMapping(
	stripeAccountId: string,
	stripeObjectType: string,
	stripeObjectId: string,
): { zohoEntityType: string; zohoEntityId: string } | undefined {
	return db
		.select({
			zohoEntityType: syncMappings.zohoEntityType,
			zohoEntityId: syncMappings.zohoEntityId,
		})
		.from(syncMappings)
		.where(
			and(
				eq(syncMappings.stripeAccountId, stripeAccountId),
				eq(syncMappings.stripeObjectType, stripeObjectType),
				eq(syncMappings.stripeObjectId, stripeObjectId),
			),
		)
		.get();
}

export function createMapping(params: {
	stripeAccountId: string;
	stripeObjectType: string;
	stripeObjectId: string;
	zohoEntityType: string;
	zohoEntityId: string;
	metadata?: Record<string, unknown>;
}): void {
	db.insert(syncMappings)
		.values({
			stripeAccountId: params.stripeAccountId,
			stripeObjectType: params.stripeObjectType,
			stripeObjectId: params.stripeObjectId,
			zohoEntityType: params.zohoEntityType,
			zohoEntityId: params.zohoEntityId,
			metadata: params.metadata ? JSON.stringify(params.metadata) : null,
		})
		.run();
}

export function deleteMapping(
	stripeAccountId: string,
	stripeObjectType: string,
	stripeObjectId: string,
): void {
	db.delete(syncMappings)
		.where(
			and(
				eq(syncMappings.stripeAccountId, stripeAccountId),
				eq(syncMappings.stripeObjectType, stripeObjectType),
				eq(syncMappings.stripeObjectId, stripeObjectId),
			),
		)
		.run();
}

export function logSync(
	level: "info" | "warn" | "error",
	message: string,
	stripeAccountId?: string,
	context?: Record<string, unknown>,
): void {
	db.insert(syncLog)
		.values({
			stripeAccountId: stripeAccountId ?? null,
			level,
			message,
			context: context ? JSON.stringify(context) : null,
		})
		.run();
}
