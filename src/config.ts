import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
	port: z.coerce.number().default(3000),
	host: z.string().default("0.0.0.0"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	databasePath: z.string().default("./data/stripe2zoho.db"),
	adminPassword: z.string().min(1, "ADMIN_PASSWORD is required"),
	encryptionKey: z.string().optional(),
	syncMode: z.enum(["poll", "webhook"]).default("poll"),
	pollIntervalSeconds: z.coerce.number().default(60),
	zoho: z.object({
		clientId: z.string().optional(),
		clientSecret: z.string().optional(),
		refreshToken: z.string().optional(),
		organizationId: z.string().optional(),
		apiDomain: z.string().default("https://www.zohoapis.com"),
	}),
});

export type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
	return configSchema.parse({
		port: process.env.PORT,
		host: process.env.HOST,
		logLevel: process.env.LOG_LEVEL,
		databasePath: process.env.DATABASE_PATH,
		adminPassword: process.env.ADMIN_PASSWORD,
		encryptionKey: process.env.ENCRYPTION_KEY,
		syncMode: process.env.SYNC_MODE,
		pollIntervalSeconds: process.env.POLL_INTERVAL_SECONDS,
		zoho: {
			clientId: process.env.ZOHO_CLIENT_ID,
			clientSecret: process.env.ZOHO_CLIENT_SECRET,
			refreshToken: process.env.ZOHO_REFRESH_TOKEN,
			organizationId: process.env.ZOHO_ORGANIZATION_ID,
			apiDomain: process.env.ZOHO_API_DOMAIN,
		},
	});
}

export const config = loadConfig();
