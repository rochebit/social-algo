import {
  getEvaluationQueueBatch,
  deleteFromEvaluationQueue,
  incrementEvaluationQueueRetry,
  getEvaluationQueueSize,
  getGeminiFailureCount24h,
  getLastProcessingError,
  logProcessingFailure
} from "./db";
import { evaluatePost, isMockEvaluatorActive } from "./gemini";
import { writePost, publishStats } from "./firestore";
import { resolveParentContext, resolveQuotedContext } from "./jetstream";

const BATCH_INTERVAL_SECONDS = parseInt(process.env.BATCH_INTERVAL_SECONDS || "300", 10);
const BATCH_EVAL_CAP = parseInt(process.env.BATCH_EVAL_CAP || "100", 10);

let batchIntervalId: NodeJS.Timeout | null = null;
let heartbeatIntervalId: NodeJS.Timeout | null = null;

let isRunningBatch = false;

// Track stats in memory
let lastBatchTime: string = new Date().toISOString();
let lastBatchProcessedCount = 0;
let lastBatchSuccessCount = 0;
let lastBatchRelevantCount = 0;

export async function runBatchEvaluation(): Promise<void> {
  if (isRunningBatch) {
    console.log("[Batch Worker] Batch evaluation already in progress, skipping.");
    return;
  }
  isRunningBatch = true;
  console.log(`[Batch Worker] Running batch evaluation (cap: ${BATCH_EVAL_CAP})...`);

  let processedCount = 0;
  let successCount = 0;
  let relevantCount = 0;

  try {
    const batch = getEvaluationQueueBatch(BATCH_EVAL_CAP);
    processedCount = batch.length;

    if (batch.length > 0) {
      for (const item of batch) {
        // Construct mock record for resolveParentContext and resolveQuotedContext
        const mockRecord = {
          reply: item.reply ? JSON.parse(item.reply) : undefined,
          embed: item.embed ? JSON.parse(item.embed) : undefined
        };

        let parentContext = null;
        let quotedContext = null;

        // 1. Resolve Contexts
        try {
          parentContext = await resolveParentContext(mockRecord);
          quotedContext = await resolveQuotedContext(mockRecord);
        } catch (err: any) {
          console.error(`[Batch Worker] Error fetching context for post ${item.uri}:`, err);
          
          // Increment retry count
          incrementEvaluationQueueRetry(item.uri);
          const currentRetryCount = item.retry_count + 1; // plus the one we just incremented

          if (currentRetryCount > 3) {
            logProcessingFailure("context_fetch", JSON.stringify({ uri: item.uri, cid: item.cid, reply: item.reply ? JSON.parse(item.reply) : undefined, embed: item.embed ? JSON.parse(item.embed) : undefined }), err.message || String(err));
            deleteFromEvaluationQueue(item.uri);
          }
          continue; // Go to next post in batch
        }

        // 2. Evaluate Post
        let evalResult;
        try {
          const matchRulesParsed = JSON.parse(item.match_rules);
          evalResult = await evaluatePost(
            item.text,
            item.author_handle,
            parentContext,
            quotedContext,
            matchRulesParsed
          );
        } catch (err: any) {
          console.error(`[Batch Worker] Error calling Gemini API for post ${item.uri}:`, err);

          // Increment retry count
          incrementEvaluationQueueRetry(item.uri);
          const currentRetryCount = item.retry_count + 1; // plus the one we just incremented

          if (currentRetryCount > 3) {
            logProcessingFailure("gemini_call", JSON.stringify({ uri: item.uri, cid: item.cid, reply: item.reply ? JSON.parse(item.reply) : undefined, embed: item.embed ? JSON.parse(item.embed) : undefined }), err.message || String(err));
            deleteFromEvaluationQueue(item.uri);
          }

          // Delay for 4.2 seconds to respect free tier rate limit (max 15 RPM)
          if (process.env.NODE_ENV !== "test" && !isMockEvaluatorActive()) {
            await new Promise((resolve) => setTimeout(resolve, 4200));
          }
          continue; // Go to next post in batch
        }

        // 3. Outcome Routing
        try {
          successCount++;
          if (evalResult.isRelevant) {
            relevantCount++;
            
            const facetsParsed = JSON.parse(item.facets || "[]");
            const mediaEmbedParsed = JSON.parse(item.media_embed || "{}");
            const matchRulesParsed = JSON.parse(item.match_rules);

            await writePost({
              uri: item.uri,
              cid: item.cid,
              authorDid: item.author_did,
              authorHandle: item.author_handle,
              text: item.text,
              createdAt: item.created_at,
              matchedAt: item.matched_at,
              relevanceScore: evalResult.score,
              relevanceExplanation: evalResult.reasoning,
              matchRules: matchRulesParsed,
              isDeleted: false,
              facets: facetsParsed,
              mediaEmbed: mediaEmbedParsed,
              parentContext,
              quotedContext
            });
          }

          // Successfully processed (either relevant or irrelevant)
          deleteFromEvaluationQueue(item.uri);
        } catch (err: any) {
          console.error(`[Batch Worker] Error writing evaluated post to outbox/Firestore:`, err);
          // Delete it so it's not stuck
          deleteFromEvaluationQueue(item.uri);
        }

        // Delay for 4.2 seconds to respect free tier rate limit (max 15 RPM)
        if (process.env.NODE_ENV !== "test" && !isMockEvaluatorActive()) {
          await new Promise((resolve) => setTimeout(resolve, 4200));
        }
      }
    }

    lastBatchTime = new Date().toISOString();
    lastBatchProcessedCount = processedCount;
    lastBatchSuccessCount = successCount;
    lastBatchRelevantCount = relevantCount;
  } catch (globalErr) {
    console.error("[Batch Worker] Error in batch execution:", globalErr);
  } finally {
    isRunningBatch = false;
    // Always publish statistics immediately after batch run completes
    await triggerHeartbeat();
  }
}

export async function triggerHeartbeat(): Promise<void> {
  const queueSize = getEvaluationQueueSize();
  const geminiFailureCount24h = getGeminiFailureCount24h();
  const lastError = getLastProcessingError();

  await publishStats({
    lastActive: new Date().toISOString(),
    lastBatchTime,
    queueSize,
    geminiFailureCount24h,
    lastBatchProcessedCount,
    lastBatchSuccessCount,
    lastBatchRelevantCount,
    lastError,
    backendStatus: "online"
  });
}

export function startBatchWorker(): void {
  const intervalSec = parseInt(process.env.BATCH_INTERVAL_SECONDS || "300", 10);
  const cap = parseInt(process.env.BATCH_EVAL_CAP || "100", 10);
  console.log(`[Batch Worker] Starting batch worker with interval: ${intervalSec}s, cap: ${cap}`);
  
  // Run immediately on startup
  runBatchEvaluation().catch(err => {
    console.error("[Batch Worker] Initial startup batch execution failed:", err);
  });

  // Setup periodic batch interval
  batchIntervalId = setInterval(() => {
    runBatchEvaluation().catch(err => {
      console.error("[Batch Worker] Batch execution error:", err);
    });
  }, intervalSec * 1000);

  // Setup periodic 60s heartbeat
  heartbeatIntervalId = setInterval(() => {
    triggerHeartbeat().catch(err => {
      console.error("[Batch Worker] Heartbeat publication error:", err);
    });
  }, 60000);
}

export function stopBatchWorker(): void {
  if (batchIntervalId) {
    clearInterval(batchIntervalId);
    batchIntervalId = null;
  }
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  console.log("[Batch Worker] Batch worker stopped.");
}
