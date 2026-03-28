import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import * as schema from "./schema.js";

const dbPath = config.databasePath;
const dir = dirname(dbPath);
if (!existsSync(dir)) {
	mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function initializeDatabase() {
	logger.info("Initializing database...");

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS stripe_accounts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			stripe_account_id TEXT NOT NULL UNIQUE,
			api_key TEXT NOT NULL,
			webhook_secret TEXT,
			zoho_fee_account_id TEXT,
			zoho_clearing_account_id TEXT,
			zoho_bank_account_id TEXT,
			is_active INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS zoho_config (
			id INTEGER PRIMARY KEY DEFAULT 1,
			organization_id TEXT NOT NULL,
			client_id TEXT NOT NULL,
			client_secret TEXT NOT NULL,
			refresh_token TEXT NOT NULL,
			access_token TEXT,
			access_token_expires_at TEXT,
			api_domain TEXT NOT NULL DEFAULT 'https://www.zohoapis.com',
			stripe_fee_account_id TEXT,
			stripe_clearing_account_id TEXT,
			bank_account_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS sync_mappings (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stripe_account_id TEXT NOT NULL,
			stripe_object_type TEXT NOT NULL,
			stripe_object_id TEXT NOT NULL,
			zoho_entity_type TEXT NOT NULL,
			zoho_entity_id TEXT NOT NULL,
			metadata TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE UNIQUE INDEX IF NOT EXISTS uniq_stripe_object
			ON sync_mappings(stripe_account_id, stripe_object_type, stripe_object_id);

		CREATE TABLE IF NOT EXISTS webhook_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stripe_account_id TEXT NOT NULL,
			event_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			error_message TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			next_retry_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			processed_at TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS uniq_event
			ON webhook_events(stripe_account_id, event_id);

		CREATE TABLE IF NOT EXISTS job_queue (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			job_type TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			priority INTEGER NOT NULL DEFAULT 0,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 5,
			last_error TEXT,
			next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
			locked_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			completed_at TEXT
		);

		CREATE TABLE IF NOT EXISTS sync_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			stripe_account_id TEXT,
			level TEXT NOT NULL,
			message TEXT NOT NULL,
			context TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);

	// Migrations for existing databases
	const stripeAccountColumns = sqlite.pragma("table_info(stripe_accounts)") as Array<{ name: string }>;
	const stripeAccountColumnNames = stripeAccountColumns.map((c) => c.name);

	if (!stripeAccountColumnNames.includes("zoho_fee_account_id")) {
		sqlite.exec(`
			ALTER TABLE stripe_accounts ADD COLUMN zoho_fee_account_id TEXT;
			ALTER TABLE stripe_accounts ADD COLUMN zoho_clearing_account_id TEXT;
			ALTER TABLE stripe_accounts ADD COLUMN zoho_bank_account_id TEXT;
		`);
		logger.info("Migrated stripe_accounts: added Zoho account ID columns");
	}

	const columns = sqlite.pragma("table_info(zoho_config)") as Array<{ name: string }>;
	const columnNames = columns.map((c) => c.name);

	if (!columnNames.includes("stripe_fee_account_id")) {
		sqlite.exec(`
			ALTER TABLE zoho_config ADD COLUMN stripe_fee_account_id TEXT;
			ALTER TABLE zoho_config ADD COLUMN stripe_clearing_account_id TEXT;
			ALTER TABLE zoho_config ADD COLUMN bank_account_id TEXT;
		`);
		logger.info("Migrated zoho_config: added account ID columns");
	}

	// Seed zoho_config from env vars if not already present
	const existingZohoConfig = sqlite.prepare("SELECT id FROM zoho_config WHERE id = 1").get();
	if (!existingZohoConfig && config.zoho.clientId && config.zoho.clientSecret && config.zoho.refreshToken && config.zoho.organizationId) {
		sqlite.prepare(`
			INSERT INTO zoho_config (id, organization_id, client_id, client_secret, refresh_token, api_domain)
			VALUES (1, ?, ?, ?, ?, ?)
		`).run(
			config.zoho.organizationId,
			config.zoho.clientId,
			config.zoho.clientSecret,
			config.zoho.refreshToken,
			config.zoho.apiDomain,
		);
		logger.info("Seeded zoho_config from environment variables");
	}

	logger.info("Database initialized");
}
