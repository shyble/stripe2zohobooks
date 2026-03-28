import { eq, and, lte, sql, isNull, or } from "drizzle-orm";
import { db } from "../db/connection.js";
import { jobQueue, webhookEvents, syncLog } from "../db/schema.js";
import { processEvent } from "../sync/engine.js";
import { runBackfill } from "../backfill/runner.js";
import { logger } from "../utils/logger.js";

const POLL_INTERVAL_MS = 2000;
let running = false;

async function processJob(job: typeof jobQueue.$inferSelect): Promise<void> {
	const payload = JSON.parse(job.payload);

	switch (job.jobType) {
		case "process_event":
			await processEvent(payload.stripeAccountId, payload.eventId);
			break;
		case "backfill":
			await runBackfill(payload.stripeAccountId, payload.dateFrom, payload.dateTo);
			break;
		default:
			throw new Error(`Unknown job type: ${job.jobType}`);
	}
}

async function pollAndProcess(): Promise<void> {
	const now = new Date().toISOString();

	// Try to lock a job atomically
	const job = db
		.select()
		.from(jobQueue)
		.where(
			and(
				or(eq(jobQueue.status, "pending"), eq(jobQueue.status, "failed")),
				lte(jobQueue.nextRunAt, now),
				isNull(jobQueue.lockedAt),
			),
		)
		.orderBy(jobQueue.priority, jobQueue.nextRunAt)
		.limit(1)
		.get();

	if (!job) return;

	// Lock the job
	const lockResult = db
		.update(jobQueue)
		.set({ status: "processing", lockedAt: now })
		.where(and(eq(jobQueue.id, job.id), isNull(jobQueue.lockedAt)))
		.run();

	if (lockResult.changes === 0) return; // Another worker got it

	try {
		await processJob(job);

		// Mark completed
		db.update(jobQueue)
			.set({
				status: "completed",
				completedAt: new Date().toISOString(),
				lockedAt: null,
			})
			.where(eq(jobQueue.id, job.id))
			.run();

		logger.debug({ jobId: job.id, jobType: job.jobType }, "Job completed");
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		const attempts = job.attempts + 1;

		if (attempts >= job.maxAttempts) {
			// Dead letter
			db.update(jobQueue)
				.set({
					status: "dead",
					attempts,
					lastError: errorMessage,
					lockedAt: null,
				})
				.where(eq(jobQueue.id, job.id))
				.run();

			// Log the dead job
			db.insert(syncLog)
				.values({
					level: "error",
					message: `Job permanently failed after ${attempts} attempts: ${errorMessage}`,
					context: job.payload,
				})
				.run();

			logger.error(
				{ jobId: job.id, jobType: job.jobType, attempts, error: errorMessage },
				"Job moved to dead letter",
			);
		} else {
			// Retry with exponential backoff: min(2^attempts * 30s, 1 hour)
			const backoffMs = Math.min(Math.pow(2, attempts) * 30_000, 3_600_000);
			const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

			db.update(jobQueue)
				.set({
					status: "failed",
					attempts,
					lastError: errorMessage,
					nextRunAt: nextRetryAt,
					lockedAt: null,
				})
				.where(eq(jobQueue.id, job.id))
				.run();

			logger.warn(
				{
					jobId: job.id,
					jobType: job.jobType,
					attempts,
					nextRetryAt,
					error: errorMessage,
				},
				"Job failed, will retry",
			);
		}
	}
}

export function startWorker(): void {
	if (running) return;
	running = true;

	logger.info("Job worker started");

	const poll = async () => {
		if (!running) return;

		try {
			await pollAndProcess();
		} catch (err) {
			logger.error({ error: err }, "Worker poll error");
		}

		setTimeout(poll, POLL_INTERVAL_MS);
	};

	poll();
}

export function stopWorker(): void {
	running = false;
	logger.info("Job worker stopped");
}
