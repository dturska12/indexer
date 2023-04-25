/* eslint-disable @typescript-eslint/no-explicit-any */

import { Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";
import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { config } from "@/config/index";

const QUEUE_NAME = "backfill-cancel-events-created-at";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 1000,
    removeOnFail: 10000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const limit = 1000;
      const results = await idb.manyOrNone(
        `
            UPDATE cancel_events ce SET
                created_at = to_timestamp(x.timestamp)
            FROM (
                SELECT timestamp, block_hash, tx_hash, log_index
                FROM cancel_events
                WHERE created_at IS NULL
                LIMIT 1000
            ) x
            WHERE ce.block_hash = x.block_hash AND ce.tx_hash = x.tx_hash AND ce.log_index = x.log_index
            RETURNING created_at
          `
      );

      if (results.length == limit) {
        await addToQueue();
      }

      logger.info(QUEUE_NAME, `Processed ${results.length} events. limit=${limit}`);
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const addToQueue = async () => {
  await queue.add(randomUUID(), {}, { delay: 1000 });
};
