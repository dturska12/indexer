import { Job, Queue, QueueScheduler, Worker } from "bullmq";

import { idb, redb } from "@/common/db";
import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { fromBuffer, toBuffer } from "@/common/utils";
import { config } from "@/config/index";

import * as tokenUpdatesRefreshCache from "@/jobs/token-updates/token-refresh-cache";

const QUEUE_NAME = "collection-updates-floor-ask-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 20000,
    },
    removeOnComplete: 1000,
    removeOnFail: 10000,
    timeout: 60000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { kind, contract, tokenId, txHash, txTimestamp } = job.data as FloorAskInfo;

      try {
        // First, retrieve the token's associated collection.
        const collectionResult = await redb.oneOrNone(
          `
            SELECT tokens.collection_id FROM tokens
            WHERE tokens.contract = $/contract/
              AND tokens.token_id = $/tokenId/
          `,
          {
            contract: toBuffer(contract),
            tokenId,
          }
        );

        if (!collectionResult?.collection_id) {
          // Skip if the token is not associated to a collection.
          return;
        }

        const collectionFloorAsk = await idb.oneOrNone(
          `
            WITH y AS (
              UPDATE collections SET
                floor_sell_id = x.floor_sell_id,
                floor_sell_value = x.floor_sell_value,
                floor_sell_maker = x.floor_sell_maker,
                floor_sell_source_id_int = x.source_id_int,
                floor_sell_valid_between = x.valid_between,
                updated_at = now()
              FROM (
                WITH collection_floor_sell AS (
                    SELECT
                      tokens.floor_sell_id,
                      tokens.floor_sell_value,
                      tokens.floor_sell_maker,
                      orders.source_id_int,
                      orders.valid_between
                    FROM tokens
                    JOIN orders
                      ON tokens.floor_sell_id = orders.id
                    WHERE tokens.collection_id = $/collection/
                    ORDER BY tokens.floor_sell_value
                    LIMIT 1
                )
                SELECT
                    collection_floor_sell.floor_sell_id,
                    collection_floor_sell.floor_sell_value,
                    collection_floor_sell.floor_sell_maker,
                    collection_floor_sell.source_id_int,
                    collection_floor_sell.valid_between
                FROM collection_floor_sell
                UNION ALL
                SELECT NULL, NULL, NULL, NULL, NULL
                WHERE NOT EXISTS (SELECT 1 FROM collection_floor_sell)
              ) x
              WHERE collections.id = $/collection/
                AND (
                  collections.floor_sell_id IS DISTINCT FROM x.floor_sell_id
                  OR collections.floor_sell_value IS DISTINCT FROM x.floor_sell_value
                )
              RETURNING
                collections.floor_sell_id,
                collections.floor_sell_value,
                (
                  SELECT
                    collections.floor_sell_value
                  FROM collections
                  WHERE id = $/collection/
                ) AS old_floor_sell_value,
                collections.floor_sell_maker,
                collections.floor_sell_source_id_int,
                collections.floor_sell_valid_between
            )
            INSERT INTO collection_floor_sell_events(
              kind,
              collection_id,
              contract,
              token_id,
              order_id,
              order_source_id_int,
              order_valid_between,
              maker,
              price,
              previous_price,
              tx_hash,
              tx_timestamp
            )
            SELECT
              $/kind/::token_floor_sell_event_kind_t,
              $/collection/,
              z.contract,
              z.token_id,
              y.floor_sell_id,
              y.floor_sell_source_id_int,
              y.floor_sell_valid_between,
              y.floor_sell_maker,
              y.floor_sell_value,
              y.old_floor_sell_value,
              $/txHash/,
              $/txTimestamp/
            FROM y
            LEFT JOIN LATERAL (
              SELECT
                token_sets_tokens.contract,
                token_sets_tokens.token_id
              FROM token_sets_tokens
              JOIN orders
                ON token_sets_tokens.token_set_id = orders.token_set_id
              WHERE orders.id = y.floor_sell_id
              LIMIT 1
            ) z ON TRUE
            RETURNING order_id
          `,
          {
            kind,
            collection: collectionResult.collection_id,
            contract: toBuffer(contract),
            tokenId,
            txHash: txHash ? toBuffer(txHash) : null,
            txTimestamp,
          }
        );

        if (collectionFloorAsk) {
          await redis.del(`collection-floor-ask:${collectionResult.collection_id}`);

          const floorToken = await idb.oneOrNone(
            `
              SELECT
                tokens.contract,
                tokens.token_id
              FROM tokens
              WHERE tokens.collection_id = $/collection/
              ORDER BY tokens.floor_sell_value
              LIMIT 1
            `,
            {
              collection: collectionResult.collection_id,
            }
          );
          if (floorToken) {
            await tokenUpdatesRefreshCache.addToQueue(
              fromBuffer(floorToken.contract),
              floorToken.token_id
            );
          }
        }
      } catch (error) {
        logger.error(
          QUEUE_NAME,
          `Failed to process collection floor-ask info ${JSON.stringify(job.data)}: ${error}`
        );
        throw error;
      }
    },
    { connection: redis.duplicate(), concurrency: 5 }
  );
  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export type FloorAskInfo = {
  kind: string;
  contract: string;
  tokenId: string;
  txHash: string | null;
  txTimestamp: number | null;
};

export const addToQueue = async (floorAskInfos: FloorAskInfo[]) => {
  await queue.addBulk(
    floorAskInfos.map((floorAskInfo) => ({
      name: `${floorAskInfo.contract}-${floorAskInfo.tokenId}`,
      data: floorAskInfo,
    }))
  );
};
