import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const stripeAccounts = sqliteTable("stripe_accounts", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name").notNull(),
	stripeAccountId: text("stripe_account_id").notNull().unique(),
	apiKey: text("api_key").notNull(),
	webhookSecret: text("webhook_secret"),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	zohoFeeAccountId: text("zoho_fee_account_id"),
	zohoClearingAccountId: text("zoho_clearing_account_id"),
	zohoBankAccountId: text("zoho_bank_account_id"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const zohoConfig = sqliteTable("zoho_config", {
	id: integer("id").primaryKey().default(1),
	organizationId: text("organization_id").notNull(),
	clientId: text("client_id").notNull(),
	clientSecret: text("client_secret").notNull(),
	refreshToken: text("refresh_token").notNull(),
	accessToken: text("access_token"),
	accessTokenExpiresAt: text("access_token_expires_at"),
	apiDomain: text("api_domain").notNull().default("https://www.zohoapis.com"),
	stripeFeeAccountId: text("stripe_fee_account_id"),
	stripeClearingAccountId: text("stripe_clearing_account_id"),
	bankAccountId: text("bank_account_id"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const syncMappings = sqliteTable(
	"sync_mappings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		stripeAccountId: text("stripe_account_id").notNull(),
		stripeObjectType: text("stripe_object_type").notNull(),
		stripeObjectId: text("stripe_object_id").notNull(),
		zohoEntityType: text("zoho_entity_type").notNull(),
		zohoEntityId: text("zoho_entity_id").notNull(),
		metadata: text("metadata"),
		createdAt: text("created_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updated_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("uniq_stripe_object").on(
			table.stripeAccountId,
			table.stripeObjectType,
			table.stripeObjectId,
		),
	],
);

export const webhookEvents = sqliteTable(
	"webhook_events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		stripeAccountId: text("stripe_account_id").notNull(),
		eventId: text("event_id").notNull(),
		eventType: text("event_type").notNull(),
		payload: text("payload").notNull(),
		status: text("status", {
			enum: ["pending", "processing", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		errorMessage: text("error_message"),
		attempts: integer("attempts").notNull().default(0),
		nextRetryAt: text("next_retry_at"),
		createdAt: text("created_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		processedAt: text("processed_at"),
	},
	(table) => [
		uniqueIndex("uniq_event").on(table.stripeAccountId, table.eventId),
	],
);

export const jobQueue = sqliteTable("job_queue", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	jobType: text("job_type").notNull(),
	payload: text("payload").notNull(),
	status: text("status", {
		enum: ["pending", "processing", "completed", "failed", "dead"],
	})
		.notNull()
		.default("pending"),
	priority: integer("priority").notNull().default(0),
	attempts: integer("attempts").notNull().default(0),
	maxAttempts: integer("max_attempts").notNull().default(5),
	lastError: text("last_error"),
	nextRunAt: text("next_run_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	lockedAt: text("locked_at"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	completedAt: text("completed_at"),
});

export const syncLog = sqliteTable("sync_log", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	stripeAccountId: text("stripe_account_id"),
	level: text("level", { enum: ["info", "warn", "error"] }).notNull(),
	message: text("message").notNull(),
	context: text("context"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});
