import { db } from "../db/connection.js";
import { jobQueue } from "../db/schema.js";
import { logger } from "../utils/logger.js";

export function enqueueJob(
	jobType: string,
	payload: Record<string, unknown>,
	options?: { priority?: number; maxAttempts?: number; delayMs?: number },
) {
	const nextRunAt = options?.delayMs
		? new Date(Date.now() + options.delayMs).toISOString()
		: new Date().toISOString();

	db.insert(jobQueue)
		.values({
			jobType,
			payload: JSON.stringify(payload),
			priority: options?.priority ?? 0,
			maxAttempts: options?.maxAttempts ?? 5,
			nextRunAt,
		})
		.run();

	logger.debug({ jobType, payload }, "Job enqueued");
}
