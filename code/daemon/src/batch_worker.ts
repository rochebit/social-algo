import {
  getEvaluationQueueBatch,
  deleteFromEvaluationQueue,
  incrementEvaluationQueueRetry,
  getEvaluationQueueSize,
  getGeminiFailureCount24h,
  getLastProcessingError,
  logProcessingFailure,
  logMetric,
  pruneMetrics,
  getMetricsCounts,
  getLatestMetricTimestamp
} from "./db";
import { lastFirehosePostAt, lastPassedStage1At } from "./jetstream";

export let lastPassedStage2At: string | null = null;

export function initBatchWorkerState(): void {
  lastPassedStage2At = getLatestMetricTimestamp("passed_stage2");
}
import { evaluatePostsBatch, BatchEvaluationRequest, isMockEvaluatorActive } from "./gemini";
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

  try {
    pruneMetrics();
  } catch (err) {
    console.error("[Batch Worker] Failed to prune metrics:", err);
  }

  let processedCount = 0;
  let successCount = 0;
  let relevantCount = 0;

  try {
    const batch = getEvaluationQueueBatch(BATCH_EVAL_CAP);
    if (batch.length === 0) {
      return;
    }

    const evaluationRequests: BatchEvaluationRequest[] = [];
    const postsMap = new Map<string, typeof batch[0]>();
    const contextsMap = new Map<string, { parentContext: any; quotedContext: any }>();

    // 1. Resolve Contexts for all posts
    for (const item of batch) {
      postsMap.set(item.uri, item);
      const mockRecord = {
        reply: item.reply ? JSON.parse(item.reply) : undefined,
        embed: item.embed ? JSON.parse(item.embed) : undefined
      };

      let parentContext = null;
      let quotedContext = null;

      try {
        parentContext = await resolveParentContext(mockRecord);
        quotedContext = await resolveQuotedContext(mockRecord);
        
        contextsMap.set(item.uri, { parentContext, quotedContext });
        evaluationRequests.push({
          uri: item.uri,
          text: item.text,
          parentContext,
          quotedContext,
          capturePath: JSON.parse(item.match_rules)
        });
      } catch (err: any) {
        console.error(`[Batch Worker] Error fetching context for post ${item.uri}:`, err);
        
        // Increment retry count
        incrementEvaluationQueueRetry(item.uri);
        const currentRetryCount = item.retry_count + 1;

        if (currentRetryCount > 3) {
          logProcessingFailure("context_fetch", JSON.stringify({ uri: item.uri, cid: item.cid, reply: item.reply ? JSON.parse(item.reply) : undefined, embed: item.embed ? JSON.parse(item.embed) : undefined }), err.message || String(err));
          deleteFromEvaluationQueue(item.uri);
        }
      }
    }

    processedCount = evaluationRequests.length;
    if (evaluationRequests.length === 0) {
      return;
    }

    // 2. Single API Evaluation Call
    let batchResults;
    try {
      batchResults = await evaluatePostsBatch(evaluationRequests);
    } catch (err: any) {
      console.error("[Batch Worker] Error in batch Gemini API call:", err);

      // Batch Error & Retry Handling
      for (const req of evaluationRequests) {
        const item = postsMap.get(req.uri)!;
        incrementEvaluationQueueRetry(item.uri);
        const currentRetryCount = item.retry_count + 1;

        if (currentRetryCount > 3) {
          logProcessingFailure("gemini_call", JSON.stringify({ uri: item.uri, cid: item.cid, reply: item.reply ? JSON.parse(item.reply) : undefined, embed: item.embed ? JSON.parse(item.embed) : undefined }), err.message || String(err));
          deleteFromEvaluationQueue(item.uri);
        }
      }
      return;
    }

    // 3. Outcome Routing
    for (const result of batchResults) {
      const item = postsMap.get(result.uri);
      if (!item) continue;

      const contexts = contextsMap.get(result.uri);
      const parentContext = contexts ? contexts.parentContext : null;
      const quotedContext = contexts ? contexts.quotedContext : null;

      try {
        console.log(`[Batch Worker] Evaluated post by @${item.author_handle}: isRelevant=${result.isRelevant}, score=${result.score}, explanation="${result.reasoning.substring(0, 80)}"`);
        successCount++;
        if (result.isRelevant) {
          relevantCount++;
          
          const facetsParsed = JSON.parse(item.facets || "[]");
          const mediaEmbedParsed = JSON.parse(item.media_embed || "{}");
          const matchRulesParsed = JSON.parse(item.match_rules);

          const systemVersion = process.env.SYSTEM_VERSION || "v1.0.0";

          await writePost({
            uri: item.uri,
            cid: item.cid,
            authorDid: item.author_did,
            authorHandle: item.author_handle,
            text: item.text,
            createdAt: item.created_at,
            matchedAt: item.matched_at,
            relevanceScore: result.score,
            relevanceExplanation: result.reasoning,
            matchRules: matchRulesParsed,
            isDeleted: false,
            facets: facetsParsed,
            mediaEmbed: mediaEmbedParsed,
            parentContext,
            quotedContext,
            version: systemVersion
          });

          // Immediately write a metrics entry and update local variable
          logMetric("passed_stage2");
          lastPassedStage2At = new Date().toISOString();
        }

        // Successfully processed (either relevant or irrelevant)
        deleteFromEvaluationQueue(item.uri);
      } catch (err: any) {
        console.error(`[Batch Worker] Error writing evaluated post to outbox/Firestore for ${item.uri}:`, err);
        // Delete it so it's not stuck
        deleteFromEvaluationQueue(item.uri);
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
  const counts = getMetricsCounts();
  const systemVersion = process.env.SYSTEM_VERSION || "v1.0.0";

  await publishStats({
    lastActive: new Date().toISOString(),
    lastBatchTime,
    queueSize,
    geminiFailureCount24h,
    lastBatchProcessedCount,
    lastBatchSuccessCount,
    lastBatchRelevantCount,
    lastError,
    backendStatus: "online",
    version: systemVersion,
    firehoseCount1h: counts.firehoseCount1h,
    firehoseCount24h: counts.firehoseCount24h,
    passedStage1Count1h: counts.passedStage1Count1h,
    passedStage1Count24h: counts.passedStage1Count24h,
    passedStage2Count1h: counts.passedStage2Count1h,
    passedStage2Count24h: counts.passedStage2Count24h,
    lastFirehosePostAt,
    lastPassedStage1At,
    lastPassedStage2At
  });
}

export function startBatchWorker(): void {
  const intervalSec = parseInt(process.env.BATCH_INTERVAL_SECONDS || "300", 10);
  const cap = parseInt(process.env.BATCH_EVAL_CAP || "100", 10);
  console.log(`[Batch Worker] Starting batch worker with interval: ${intervalSec}s, cap: ${cap}`);
  
  // Load state from DB on startup
  try {
    initBatchWorkerState();
  } catch (err) {
    console.error("[Batch Worker] Failed to initialize state from DB:", err);
  }
  
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
