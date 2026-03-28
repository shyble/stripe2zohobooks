import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { initializeDatabase } from "./db/connection.js";
import { app } from "./server.js";
import { startWorker } from "./queue/worker.js";
import { startPoller } from "./poller/stripe-poller.js";
import { logger } from "./utils/logger.js";

initializeDatabase();

serve(
	{
		fetch: app.fetch,
		port: config.port,
		hostname: config.host,
	},
	(info) => {
		logger.info(`Server running at http://${info.address}:${info.port}`);
		startWorker();

		if (config.syncMode === "poll") {
			startPoller();
		} else {
			logger.info("Webhook mode — waiting for Stripe to push events");
		}
	},
);
