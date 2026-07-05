// Set environment to test
process.env.NODE_ENV = "test";
process.env.AI_FILTERING_ENABLED = "true";
process.env.USER_DID = "did:plc:owner123";

import * as fs from "fs";
import * as path from "path";
import {
  initDb,
  isFollowed,
  addFirstDegreeFollow,
  setMockFetchAllFollows,
  queryLocalPost,
  queryOutboxItem,
  queryProcessingFailures,
  queueForEvaluation,
  deleteFromEvaluationQueue,
  getEvaluationQueueSize,
  getEvaluationQueueBatch,
  incrementEvaluationQueueRetry,
  clearEvaluationQueue,
  clearOutbox,
  logMetric,
  pruneMetrics,
  getMetricsCounts,
  clearMetricsLog
} from "./db";
import { setMockEvaluator } from "./gemini";
import {
  setMockDbHandlers,
  processOutbox,
  stopOutboxWorker,
  getPostId,
  setMockStatsHandler,
  setMockDeploymentHandlers,
  trackDeploymentShift
} from "./firestore";
import { handleCommit, handleUserEngagementFromUri } from "./jetstream";
import { runBatchEvaluation, triggerHeartbeat } from "./batch_worker";

// Test DB cleanup helper
const DATA_DIR = path.resolve(__dirname, "../data");
const TEST_DB_PATH = path.join(DATA_DIR, "test_network_graph.db");

function cleanTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) {
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch (e) {
      // Ignore busy file locks
    }
  }
}

// Simple test assertion helper
let testsPassedCount = 0;
let testsFailedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    testsPassedCount++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    testsFailedCount++;
  }
}

async function runTests() {
  console.log("=== Running ATProto Feed Monitor Ingestion & Filtering Test Suite ===\n");

  cleanTestDb();
  initDb();
  stopOutboxWorker(); // Prevent background execution of sync worker in tests

  // State log arrays to track database mocks
  const writtenPosts: any[] = [];
  const deletedPostUris: string[] = [];
  let geminiCallCount = 0;
  let geminiLastEvaluatedText = "";
  let geminiLastParentContext: any = null;
  let geminiLastQuotedContext: any = null;
  let geminiLastMatchRules: string[] = [];

  // 1. Setup Mock Handlers
  setMockDbHandlers(
    async (post) => {
      writtenPosts.push(post);
    },
    async (uri) => {
      deletedPostUris.push(uri);
    }
  );

  let latestStats: any = null;
  setMockStatsHandler(async (stats) => {
    latestStats = stats;
  });

  const normalMockEvaluator = async (
    text: string,
    handle: string,
    parentContext: any,
    quotedContext: any,
    matchRules: string[]
  ) => {
    geminiCallCount++;
    geminiLastEvaluatedText = text;
    geminiLastParentContext = parentContext;
    geminiLastQuotedContext = quotedContext;
    geminiLastMatchRules = matchRules || [];
    // Mock relevance check: if it mentions rust or appview, score 85, else score 0
    const isRelevant = text.toLowerCase().includes("rust") || text.toLowerCase().includes("appview") || text.toLowerCase().includes("coffee");
    return {
      isRelevant,
      score: isRelevant ? 85 : 10,
      reasoning: "Mock evaluation reasoning"
    };
  };
  setMockEvaluator(normalMockEvaluator);

  setMockFetchAllFollows(async (_did) => []);


  // ----------------------------------------------------
  // Scenario 2.1: Ingestion Parsing and Regex Matching
  // ----------------------------------------------------
  console.log("Scenario 2.1: Ingestion Parsing and Regex Matching...");
  const mockPostEvent = {
    did: "did:plc:rpqw572o3uowvjscsps5u7e6",
    time_us: 1715623456789012,
    kind: "commit",
    commit: {
      rev: "3ks5z3a2jzk2c",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3ks5z3a2jzk2c",
      cid: "bafyreihymx3",
      record: {
        $type: "app.bsky.feed.post",
        text: "My new atproto app in Rust is live, running my own PDS now!",
        createdAt: "2026-07-01T11:45:00.000Z"
      }
    }
  };

  writtenPosts.length = 0;
  geminiCallCount = 0;
  await handleCommit(mockPostEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await processOutbox();

  assert(geminiCallCount === 1, "Should route post to Gemini evaluation because it matches keywords 'atproto' and 'pds'");
  assert(geminiLastMatchRules.includes("keyword:atproto") && geminiLastMatchRules.includes("keyword:pds"), "Match rules should contain keyword:atproto and keyword:pds");
  assert(geminiLastParentContext === null, "Parent context should be null");
  assert(geminiLastQuotedContext === null, "Quoted context should be null");
  assert(writtenPosts.length === 1, "Should write relevant post to Firestore");
  assert(writtenPosts[0].authorHandle === "did:plc:rpqw572o3uowvjscsps5u7e6", "Should fall back to author DID as handle if resolve fails");
  assert(writtenPosts[0].relevanceScore === 85, "Should store evaluation score of 85");

  // Check SQLite posts table long-term storage
  const localPost = queryLocalPost("at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c");
  assert(localPost !== undefined, "Post should be recorded long-term in SQLite database");
  assert(localPost.relevance_score === 85, "SQLite post should have relevance score 85");
  assert(localPost.feedback === null, "SQLite post should start with null feedback");

  // ----------------------------------------------------
  // Scenario 2.2: Off-Topic Discard
  // ----------------------------------------------------
  console.log("\nScenario 2.2: Off-Topic Discard...");
  const offTopicPostEvent = {
    did: "did:plc:rpqw572o3uowvjscsps5u7e6",
    time_us: 1715623456789012,
    kind: "commit",
    commit: {
      rev: "3ks5z3a2jzk2c",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3ks5z3a2jzk2c",
      cid: "bafyreihymx3",
      record: {
        $type: "app.bsky.feed.post",
        text: "Had a great donut this morning! #donut #cafe",
        createdAt: "2026-07-01T11:45:00.000Z"
      }
    }
  };

  writtenPosts.length = 0;
  geminiCallCount = 0;
  await handleCommit(offTopicPostEvent, "did:plc:owner123");

  assert(geminiCallCount === 0, "Should discard off-topic post immediately and NOT query Gemini");
  assert(writtenPosts.length === 0, "Should NOT write off-topic post to Firestore");

  // ----------------------------------------------------
  // Scenario 2.3: Network Graph Bypass
  // ----------------------------------------------------
  console.log("\nScenario 2.3: Network Graph Bypass...");
  // Inject mock DID directly into 1st-degree follow table (per spec Section 3.1)
  addFirstDegreeFollow("sync:bypass-test", "did:plc:vp7572o3uowvjscsps5u7e9");
  
  const bypassPostEvent = {
    did: "did:plc:vp7572o3uowvjscsps5u7e9", 
    time_us: 1715623456789012,
    kind: "commit",
    commit: {
      rev: "3ks5z3a2jzk2c",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3ks5z3a2jzk2c",
      cid: "bafyreihymx3",
      record: {
        $type: "app.bsky.feed.post",
        text: "Had a great coffee this morning! #morning #cafe", // triggers zero regex keywords
        createdAt: "2026-07-01T11:45:00.000Z"
      }
    }
  };

  writtenPosts.length = 0;
  geminiCallCount = 0;
  await handleCommit(bypassPostEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await processOutbox();

  assert(isFollowed("did:plc:vp7572o3uowvjscsps5u7e9") === true, "Author should be recognized as a follow relationship");
  assert(geminiCallCount === 1, "Should bypass regex rules and route to Gemini because author is in network graph");
  assert(geminiLastMatchRules.includes("network:social-graph"), "Match rules should contain network:social-graph");
  assert(geminiLastParentContext === null, "Parent context should be null");
  assert(geminiLastQuotedContext === null, "Quoted context should be null");
  assert(writtenPosts.length === 1, "Should write evaluated post to Firestore");

  // ----------------------------------------------------
  // Scenario 2.4: Non-English Post Discard
  // ----------------------------------------------------
  console.log("\nScenario 2.4: Non-English Post Discard...");
  const nonEnglishPostEvent = {
    did: "did:plc:rpqw572o3uowvjscsps5u7e6",
    time_us: 1715623456789012,
    kind: "commit",
    commit: {
      rev: "3ks5z3a2jzk2c",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3ks5z3a2jzk2f",
      cid: "bafyreihymx6",
      record: {
        $type: "app.bsky.feed.post",
        text: "My new atproto app in Rust is live, running my own PDS now!", // matches keywords
        createdAt: "2026-07-01T11:45:00.000Z",
        langs: ["ja"] // Japanese language
      }
    }
  };

  writtenPosts.length = 0;
  geminiCallCount = 0;
  await handleCommit(nonEnglishPostEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await processOutbox();

  assert(geminiCallCount === 0, "Should immediately discard non-English post and NOT query Gemini");
  assert(writtenPosts.length === 0, "Should NOT write non-English post to Firestore");

  // ----------------------------------------------------
  // Scenario 2.5: Deletion Propagation
  // ----------------------------------------------------
  console.log("\nScenario 2.5: Deletion Propagation...");
  const deleteEvent = {
    did: "did:plc:rpqw572o3uowvjscsps5u7e6",
    time_us: 1715623458999999,
    kind: "commit",
    commit: {
      rev: "3ks5z3a2jzk2e",
      operation: "delete",
      collection: "app.bsky.feed.post",
      rkey: "3ks5z3a2jzk2c"
    }
  };

  deletedPostUris.length = 0;
  await handleCommit(deleteEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await processOutbox();

  assert(deletedPostUris.length === 1, "Should propagate delete event");
  assert(deletedPostUris[0] === "at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c", "Should delete post matching calculated URI");

  // Check SQLite delete status
  const localPostDeleted = queryLocalPost("at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c");
  assert(localPostDeleted?.is_deleted === 1, "Post should be marked as deleted in SQLite long-term table");

  // Test rating feedback sync in SQLite
  const { updateLocalPostFeedback } = require("./db");
  updateLocalPostFeedback("at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c", "relevant", "2026-07-03T12:00:00.000Z");
  const localPostWithFeedback = queryLocalPost("at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c");
  assert(localPostWithFeedback?.feedback === "relevant", "SQLite post feedback should update to 'relevant'");
  assert(localPostWithFeedback?.feedback_at === "2026-07-03T12:00:00.000Z", "SQLite post feedback time should update");

  // ----------------------------------------------------
  // Scenario 2.6: Batch Processing, Capping, and Backlog Ordering
  // ----------------------------------------------------
  console.log("\nScenario 2.6: Batch Processing, Capping, and Backlog Ordering...");

  clearEvaluationQueue();

  for (let i = 1; i <= 150; i++) {
    queueForEvaluation({
      uri: `at://did:plc:author${i}/app.bsky.feed.post/post${i}`,
      cid: `cid${i}`,
      authorDid: `did:plc:author${i}`,
      authorHandle: `author${i}`,
      text: `Post number ${i} about rust`,
      langs: ["en"],
      facets: [],
      mediaEmbed: {},
      matchRules: ["keyword:rust"],
      createdAt: new Date(Date.now() - (150 - i) * 1000).toISOString(),
      matchedAt: new Date(Date.now() - (150 - i) * 1000).toISOString()
    });
  }

  process.env.BATCH_EVAL_CAP = "100";
  writtenPosts.length = 0;
  geminiCallCount = 0;

  await runBatchEvaluation();
  await processOutbox();

  assert(geminiCallCount === 100, "The worker pulls exactly 100 posts from evaluation_queue");
  assert(writtenPosts.length === 100, "Should write 100 relevant posts to outbox");
  
  const hasPost50 = writtenPosts.some(p => p.uri.includes("post50"));
  const hasPost51 = writtenPosts.some(p => p.uri.includes("post51"));
  const hasPost150 = writtenPosts.some(p => p.uri.includes("post150"));
  assert(!hasPost50, "Post 50 (older post) should NOT be processed");
  assert(hasPost51 && hasPost150, "Post 51 and Post 150 (newer posts) should be processed");

  const remainingSize = getEvaluationQueueSize();
  assert(remainingSize === 50, "The 50 older posts remain in evaluation_queue");

  clearEvaluationQueue();

  // ----------------------------------------------------
  // Scenario 2.7: Retry Failure Eviction
  // ----------------------------------------------------
  console.log("\nScenario 2.7: Retry Failure Eviction...");
  clearEvaluationQueue();

  queueForEvaluation({
    uri: "at://did:plc:retryauthor/app.bsky.feed.post/post1",
    cid: "cidretry1",
    authorDid: "did:plc:retryauthor",
    authorHandle: "retryauthor",
    text: "Post with rust",
    langs: ["en"],
    facets: [],
    mediaEmbed: {},
    matchRules: ["keyword:rust"],
    createdAt: new Date().toISOString(),
    matchedAt: new Date().toISOString()
  });

  incrementEvaluationQueueRetry("at://did:plc:retryauthor/app.bsky.feed.post/post1");
  incrementEvaluationQueueRetry("at://did:plc:retryauthor/app.bsky.feed.post/post1");
  incrementEvaluationQueueRetry("at://did:plc:retryauthor/app.bsky.feed.post/post1");

  setMockEvaluator(async () => {
    throw new Error("Temporary Gemini Error");
  });

  await runBatchEvaluation();

  const queueAfterRetry = getEvaluationQueueSize();
  assert(queueAfterRetry === 0, "Because retry_count > 3, the post is deleted from evaluation_queue");

  const retryFailures = queryProcessingFailures("gemini_call");
  assert(retryFailures.length > 0 && retryFailures[0].error_message.includes("Temporary Gemini Error"), "An error entry is written to processing_failures with event_type = 'gemini_call'");

  setMockEvaluator(normalMockEvaluator);

  // ----------------------------------------------------
  // Scenario 2.8: Backend Stats Publishing
  // ----------------------------------------------------
  console.log("\nScenario 2.8: Backend Stats Publishing...");
  clearEvaluationQueue();
  latestStats = null;

  for (let i = 1; i <= 100; i++) {
    const isRelevant = i <= 20;
    queueForEvaluation({
      uri: `at://did:plc:statsauthor${i}/app.bsky.feed.post/post${i}`,
      cid: `cid${i}`,
      authorDid: `did:plc:statsauthor${i}`,
      authorHandle: `statsauthor${i}`,
      text: isRelevant ? "Post about rust" : "Post about off-topic",
      langs: ["en"],
      facets: [],
      mediaEmbed: {},
      matchRules: [isRelevant ? "keyword:rust" : "keyword:off-topic"],
      createdAt: new Date().toISOString(),
      matchedAt: new Date().toISOString()
    });
  }

  for (let i = 101; i <= 150; i++) {
    queueForEvaluation({
      uri: `at://did:plc:statsauthor${i}/app.bsky.feed.post/post${i}`,
      cid: `cid${i}`,
      authorDid: `did:plc:statsauthor${i}`,
      authorHandle: `statsauthor${i}`,
      text: "Post about rust",
      langs: ["en"],
      facets: [],
      mediaEmbed: {},
      matchRules: ["keyword:rust"],
      createdAt: new Date().toISOString(),
      matchedAt: new Date().toISOString()
    });
  }

  process.env.BATCH_EVAL_CAP = "100";
  writtenPosts.length = 0;

  await runBatchEvaluation();

  assert(latestStats !== null, "The /stats/backend document in Firestore is updated");
  assert(latestStats.queueSize === 50, "queueSize matches remaining rows in evaluation_queue (50)");
  assert(latestStats.lastBatchProcessedCount === 100, "lastBatchProcessedCount == 100");
  assert(latestStats.lastBatchSuccessCount === 100, "lastBatchSuccessCount == 100");
  assert(latestStats.lastBatchRelevantCount === 50, "lastBatchRelevantCount == 50");
  assert(latestStats.backendStatus === "online", "backendStatus == 'online'");
  assert(latestStats.lastActive !== undefined, "lastActive is updated with current timestamp");

  delete process.env.BATCH_EVAL_CAP;
  clearEvaluationQueue();

  // ----------------------------------------------------
  // Scenario 3.1: New Follow (By Owner)
  // ----------------------------------------------------
  console.log("\nScenario 3.1: New Follow (By Owner)...");
  const followEvent = {
    did: "did:plc:owner123", // OWNER_DID
    time_us: 1715623458000000,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.graph.follow",
      rkey: "3ks5z3followrkey",
      record: {
        $type: "app.bsky.graph.follow",
        subject: "did:plc:newfriend123",
        createdAt: "2026-07-01T11:45:00.000Z"
      }
    }
  };

  await handleCommit(followEvent, "did:plc:owner123");
  // Allow async follows query to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert(isFollowed("did:plc:newfriend123") === true, "New followed friend should be recorded in first_degree_follows");


  // ----------------------------------------------------
  // Scenario 3.2: Unfollow (By Owner)
  // ----------------------------------------------------
  console.log("\nScenario 3.2: Unfollow (By Owner)...");
  const unfollowEvent = {
    did: "did:plc:owner123",
    time_us: 1715623459000000,
    kind: "commit",
    commit: {
      operation: "delete",
      collection: "app.bsky.graph.follow",
      rkey: "3ks5z3followrkey"
    }
  };

  await handleCommit(unfollowEvent, "did:plc:owner123");

  assert(isFollowed("did:plc:newfriend123") === false, "Unfollowed friend should be deleted from database");


  // ----------------------------------------------------
  // Section 3: SQLite Outbox Queue Verification
  // ----------------------------------------------------
  console.log("\nSection 3: SQLite Outbox Queue Verification...");
  clearOutbox();

  // Scenario 3.1: Outbox Insertion on Match
  console.log("Scenario 3.1: Outbox Insertion on Match...");
  const outboxMatchPost = {
    did: "did:plc:testoutbox123",
    time_us: 1715623460000000,
    kind: "commit",
    commit: {
      rev: "rkeyoutbox1",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "rkeyoutbox1",
      cid: "cidoutbox1",
      record: {
        $type: "app.bsky.feed.post",
        text: "Building appview indexers in Rust",
        createdAt: "2026-07-01T12:00:00.000Z"
      }
    }
  };

  // Turn off network (mock handlers throw errors to simulate Firestore outage)
  setMockDbHandlers(
    async () => {
      throw new Error("Firestore Network Timeout");
    },
    async () => {
      throw new Error("Firestore Network Timeout");
    }
  );

  writtenPosts.length = 0;
  deletedPostUris.length = 0;

  // Ingest post
  await handleCommit(outboxMatchPost, "did:plc:owner123");
  await runBatchEvaluation();

  const postUriHash = getPostId("at://did:plc:testoutbox123/app.bsky.feed.post/rkeyoutbox1");
  const outboxItem = queryOutboxItem(postUriHash);
  assert(outboxItem !== undefined, "Post should be successfully queued in posts_outbox SQLite table");
  assert(outboxItem.action === "write", "Queued item action should be 'write'");
  assert(outboxItem.status === "pending", "Queued item status should start as 'pending'");
  assert(outboxItem.retry_count === 0, "Queued item retry_count should be 0");
  assert(writtenPosts.length === 0, "Zero writes should have reached Firestore mock");

  // Scenario 3.2: Outbox Processing under Outage (Offline Mode)
  console.log("\nScenario 3.2: Outbox Processing under Outage (Offline Mode)...");
  try {
    await processOutbox();
  } catch (e) {
    // Expected to fail
  }

  const outboxItemFailed = queryOutboxItem(postUriHash);
  assert(outboxItemFailed !== undefined, "Item should still persist in the outbox database");
  assert(outboxItemFailed.status === "failed", "Outbox item status should update to 'failed' on network failure");
  assert(outboxItemFailed.retry_count === 1, "Outbox item retry_count should increment to 1");
  assert(writtenPosts.length === 0, "Zero writes should reach Firestore during outage");

  // Scenario 3.3: Outbox Recovery (Online Mode)
  console.log("\nScenario 3.3: Outbox Recovery (Online Mode)...");
  // Restore network access
  setMockDbHandlers(
    async (post) => {
      writtenPosts.push(post);
    },
    async (uri) => {
      deletedPostUris.push(uri);
    }
  );

  // Trigger Outbox Sync
  await processOutbox();

  const outboxItemSynced = queryOutboxItem(postUriHash);
  assert(outboxItemSynced === undefined, "Successfully synced outbox row should be deleted from SQLite queue");
  assert(writtenPosts.length === 1, "Firestore mock should receive the write upon sync recovery");
  assert(writtenPosts[0].uri === "at://did:plc:testoutbox123/app.bsky.feed.post/rkeyoutbox1", "Synced post URI should match");

  // Scenario 3.4: Deletion Propagation in Outbox
  console.log("\nScenario 3.4: Deletion Propagation in Outbox...");
  const outboxDeleteEvent = {
    did: "did:plc:testoutbox123",
    time_us: 1715623461000000,
    kind: "commit",
    commit: {
      rev: "rkeyoutbox2",
      operation: "delete",
      collection: "app.bsky.feed.post",
      rkey: "rkeyoutbox1"
    }
  };

  // Offline mode again
  setMockDbHandlers(
    async () => {
      throw new Error("Firestore Network Timeout");
    },
    async () => {
      throw new Error("Firestore Network Timeout");
    }
  );

  await handleCommit(outboxDeleteEvent, "did:plc:owner123");

  const deleteOutboxItem = queryOutboxItem(postUriHash);
  assert(deleteOutboxItem !== undefined, "Delete event should be successfully queued in outbox table");
  assert(deleteOutboxItem.action === "delete", "Queued item action should be 'delete'");
  assert(deleteOutboxItem.status === "pending", "Queued delete item status should be 'pending'");

  // Restore network access and sync
  setMockDbHandlers(
    async (post) => {
      writtenPosts.push(post);
    },
    async (uri) => {
      deletedPostUris.push(uri);
    }
  );

  await processOutbox();

  const deleteOutboxItemSynced = queryOutboxItem(postUriHash);
  assert(deleteOutboxItemSynced === undefined, "Successfully synced delete event should be removed from SQLite queue");
  assert(deletedPostUris.length === 1, "Firestore mock should receive the soft delete propagation call");
  assert(deletedPostUris[0] === "at://did:plc:testoutbox123/app.bsky.feed.post/rkeyoutbox1", "Deleted post URI should match target");

  // Scenario 3.5: Exception Logging (Processing Failures) (Section 5.3)
  console.log("\nScenario 3.5: Exception Logging (Processing Failures)...");
  
  const originalFetch = global.fetch;
  global.fetch = async (url: any, init?: any) => {
    if (url.toString().includes("getPosts")) {
      return {
        ok: false,
        status: 504,
        statusText: "Gateway Timeout"
      } as Response;
    }
    return originalFetch(url, init);
  };

  const replyPostEvent = {
    did: "did:plc:tester123",
    time_us: 1715623462000000,
    kind: "commit",
    commit: {
      rev: "rkeyreply1",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "rkeyreply1",
      record: {
        $type: "app.bsky.feed.post",
        text: "Using lexicon here",
        createdAt: "2026-07-01T12:00:00.000Z",
        reply: {
          parent: { uri: "at://did:plc:parent/app.bsky.feed.post/999" },
          root: { uri: "at://did:plc:parent/app.bsky.feed.post/999" }
        }
      }
    }
  };

  await handleCommit(replyPostEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await runBatchEvaluation();
  await runBatchEvaluation();
  await runBatchEvaluation();

  // Restore fetch
  global.fetch = originalFetch;

  const failures = queryProcessingFailures("context_fetch");
  assert(failures.length > 0, "A context_fetch failure should be logged in processing_failures");
  assert(failures[0].error_message.includes("AppView API request timeout: HTTP 504"), "Error message should contain HTTP 504 info");
  assert(failures[0].raw_payload.includes("at://did:plc:parent/app.bsky.feed.post/999"), "Raw payload should contain the reply URI");

  // ----------------------------------------------------
  // Scenario 3.6: Exception Logging (Gemini Call Failures)
  // ----------------------------------------------------
  console.log("\nScenario 3.6: Exception Logging (Gemini Call Failures)...");

  // Temporarily set mock evaluator to throw an error
  setMockEvaluator(async () => {
    throw new Error("Gemini Quota Exceeded (HTTP 429)");
  });

  const errorPostEvent = {
    did: "did:plc:testerQuota",
    time_us: 1715623467000000,
    kind: "commit",
    commit: {
      rev: "rkeyquota1",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "rkeyquota1",
      cid: "bafyquotapost",
      record: {
        $type: "app.bsky.feed.post",
        text: "Evaluating post with atproto keyword during quota outage",
        createdAt: "2026-07-01T13:00:00.000Z"
      }
    }
  };

  await handleCommit(errorPostEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await runBatchEvaluation();
  await runBatchEvaluation();
  await runBatchEvaluation();

  // Restore normal mock evaluator
  setMockEvaluator(normalMockEvaluator);

  const geminiFailures = queryProcessingFailures("gemini_call");
  assert(geminiFailures.length > 0, "A gemini_call failure should be logged in processing_failures");
  assert(geminiFailures[0].error_message.includes("Gemini Quota Exceeded (HTTP 429)"), "Error message should contain quota error info");
  assert(geminiFailures[0].raw_payload.includes("rkeyquota1"), "Raw payload should contain the target post's rkey");

  // ----------------------------------------------------
  // Scenario 3.1: Liked & Reposted Content Resolver (Gap 8)
  // ----------------------------------------------------
  console.log("\nScenario 3.1: Liked & Reposted Content Resolver...");
  
  // Mock fetch for resolving post detail
  const testTargetUri = "at://did:plc:creator123/app.bsky.feed.post/post123";
  global.fetch = async (url: any, init?: any) => {
    if (url.toString().includes("getPosts") && url.toString().includes(encodeURIComponent(testTargetUri))) {
      return {
        ok: true,
        json: async () => ({
          posts: [{
            uri: testTargetUri,
            cid: "bafypostcid",
            author: {
              did: "did:plc:creator123",
              handle: "creator.bsky.social"
            },
            record: {
              text: "Testing repost resolution in Rust",
              createdAt: "2026-07-01T11:45:00.000Z"
            }
          }]
        })
      } as Response;
    }
    if (url.toString().includes("getProfile") && decodeURIComponent(url.toString()).includes("did:plc:deva12345")) {
      return {
        ok: true,
        json: async () => ({
          handle: "deva.bsky.social"
        })
      } as Response;
    }
    return originalFetch(url, init);
  };

  // Repost event from followed account did:plc:deva12345
  const repostMsg = {
    did: "did:plc:deva12345",
    time_us: 1715623459999000,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.repost",
      rkey: "3ksrepostrkey",
      record: {
        $type: "app.bsky.feed.repost",
        subject: {
          uri: testTargetUri,
          cid: "bafypostcid"
        },
        createdAt: "2026-07-01T11:45:00.000Z"
      }
    }
  };

  // Add the actor to first_degree_follows so they pass the follow check
  addFirstDegreeFollow("sync:repost-test", "did:plc:deva12345");

  writtenPosts.length = 0;
  geminiCallCount = 0;
  await handleCommit(repostMsg, "did:plc:owner123");
  await runBatchEvaluation();
  await processOutbox();

  // Restore fetch
  global.fetch = originalFetch;

  assert(geminiCallCount === 1, "Should trigger Gemini evaluation on resolved repost target post");
  assert(geminiLastMatchRules.includes("repost:deva.bsky.social"), "Match rules should contain repost:deva.bsky.social");
  assert(writtenPosts.length === 1, "Should write relevant reposted post to outbox/Firestore");
  assert(writtenPosts[0].uri === testTargetUri, "Resolved post URI should match the repost subject");

  // ----------------------------------------------------
  // Section 4: Context & Media Retrieval Verification (Gap 9)
  // ----------------------------------------------------
  console.log("\nSection 4: Context & Media Retrieval Verification...");
  
  // 4.2 Rich Text Facets Extraction
  const { parseFacets, parseMediaEmbed } = require("./jetstream");
  const mockFacetsRecord = {
    text: "Check code at link and tag #atproto",
    facets: [
      {
        index: { byteStart: 14, byteEnd: 18 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://github.com" }]
      },
      {
        index: { byteStart: 27, byteEnd: 35 },
        features: [{ $type: "app.bsky.richtext.facet#tag", tag: "atproto" }]
      }
    ]
  };
  const parsedFacets = parseFacets(mockFacetsRecord);
  assert(parsedFacets.length === 2, "Should parse two facets");
  assert(parsedFacets[0].type === "link" && parsedFacets[0].uri === "https://github.com", "Should correctly map link facet");
  assert(parsedFacets[1].type === "tag" && parsedFacets[1].tag === "atproto", "Should correctly map tag facet");

  // 4.3 Media Embed CDN URL Resolution
  const mockImageEmbed = {
    embed: {
      $type: "app.bsky.embed.images",
      images: [
        {
          image: { ref: { $link: "bafyimgcid" } },
          alt: "test alt"
        }
      ]
    }
  };
  const parsedEmbed = parseMediaEmbed(mockImageEmbed, "did:plc:author123");
  assert(parsedEmbed.type === "images", "Should parse image embed type");
  assert(parsedEmbed.images && parsedEmbed.images[0].thumbUrl === "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:author123/bafyimgcid@jpeg", "Should construct correct thumbnail CDN URL");
  assert(parsedEmbed.images && parsedEmbed.images[0].fullsizeUrl === "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:author123/bafyimgcid@jpeg", "Should construct correct fullsize CDN URL");

  // ----------------------------------------------------
  // Section 5: Gemini Relevance Pipeline Context Integration
  // ----------------------------------------------------
  console.log("\nSection 5: Gemini Relevance Pipeline Context Integration...");

  const parentUri = "at://did:plc:parentUser/app.bsky.feed.post/parentRkey";
  const quotedUri = "at://did:plc:quotedUser/app.bsky.feed.post/quotedRkey";

  const originalFetchContext = global.fetch;
  global.fetch = async (url: any, init?: any) => {
    const urlStr = url.toString();
    const decodedUrlStr = decodeURIComponent(urlStr);
    if (urlStr.includes("getProfile") && decodedUrlStr.includes("did:plc:parentUser")) {
      return { ok: true, json: async () => ({ handle: "parent.handle" }) } as Response;
    }
    if (urlStr.includes("getProfile") && decodedUrlStr.includes("did:plc:quotedUser")) {
      return { ok: true, json: async () => ({ handle: "quoted.handle" }) } as Response;
    }
    if (urlStr.includes("getProfile") && decodedUrlStr.includes("did:plc:authorWithContext")) {
      return { ok: true, json: async () => ({ handle: "author.handle" }) } as Response;
    }
    if (urlStr.includes("getPosts")) {
      if (urlStr.includes(encodeURIComponent(parentUri))) {
        return {
          ok: true,
          json: async () => ({
            posts: [{
              uri: parentUri,
              author: { did: "did:plc:parentUser", handle: "parent.handle" },
              record: { text: "This is the parent post text about atproto" }
            }]
          })
        } as Response;
      }
      if (urlStr.includes(encodeURIComponent(quotedUri))) {
        return {
          ok: true,
          json: async () => ({
            posts: [{
              uri: quotedUri,
              author: { did: "did:plc:quotedUser", handle: "quoted.handle" },
              record: { text: "This is the quoted post text" }
            }]
          })
        } as Response;
      }
    }
    return originalFetchContext(url, init);
  };

  const contextPostEvent = {
    did: "did:plc:authorWithContext",
    time_us: 1715623465000000,
    kind: "commit",
    commit: {
      rev: "rkeycontext",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "rkeycontext",
      cid: "bafycontextpost",
      record: {
        $type: "app.bsky.feed.post",
        text: "Evaluating post with parent and quote contexts atproto",
        createdAt: "2026-07-01T12:30:00.000Z",
        reply: {
          parent: { uri: parentUri },
          root: { uri: parentUri }
        },
        embed: {
          $type: "app.bsky.embed.record",
          record: { uri: quotedUri }
        }
      }
    }
  };

  writtenPosts.length = 0;
  geminiCallCount = 0;
  
  await handleCommit(contextPostEvent, "did:plc:owner123");
  await runBatchEvaluation();
  await processOutbox();

  // Restore fetch
  global.fetch = originalFetchContext;

  assert(geminiCallCount === 1, "Should trigger Gemini evaluation for post with contexts");
  assert(geminiLastParentContext !== null, "Parent context should not be null in evaluatePost call");
  assert(geminiLastParentContext?.authorHandle === "parent.handle", "Parent context author handle should match");
  assert(geminiLastParentContext?.text === "This is the parent post text about atproto", "Parent context text should match");
  assert(geminiLastQuotedContext !== null, "Quoted context should not be null in evaluatePost call");
  assert(geminiLastQuotedContext?.authorHandle === "quoted.handle", "Quoted context author handle should match");
  assert(geminiLastQuotedContext?.text === "This is the quoted post text", "Quoted context text should match");
  assert(geminiLastMatchRules.includes("keyword:atproto"), "Match rules should contain keyword:atproto");

  // ----------------------------------------------------
  // Scenario 7.10: Throughput Metrics & Database Pruning Verification
  // ----------------------------------------------------
  console.log("\nScenario 7.10: Throughput Metrics & Database Pruning Verification...");
  
  clearMetricsLog();
  const nowMs = Date.now();
  
  // Case A: 50 events logged in the last 45 minutes
  for (let i = 0; i < 50; i++) {
    const ts = new Date(nowMs - 45 * 60 * 1000 + i).toISOString();
    logMetric("firehose_received", ts);
  }
  // Case B: 30 events logged 5 hours ago
  for (let i = 0; i < 30; i++) {
    const ts = new Date(nowMs - 5 * 60 * 60 * 1000 + i).toISOString();
    logMetric("passed_stage1", ts);
  }
  // Case C: 20 events logged 26 hours ago
  for (let i = 0; i < 20; i++) {
    const ts = new Date(nowMs - 26 * 60 * 60 * 1000 + i).toISOString();
    logMetric("passed_stage2", ts);
  }

  // Verify counts before pruning
  const countsBefore = getMetricsCounts();
  assert(countsBefore.firehoseCount1h === 50, "Should have 50 firehose received events in 1h window");
  assert(countsBefore.firehoseCount24h === 50, "Should have 50 firehose received events in 24h window");
  assert(countsBefore.passedStage1Count1h === 0, "Should have 0 passed stage 1 events in 1h window");
  assert(countsBefore.passedStage1Count24h === 30, "Should have 30 passed stage 1 events in 24h window");
  assert(countsBefore.passedStage2Count1h === 0, "Should have 0 passed stage 2 events in 1h window");
  assert(countsBefore.passedStage2Count24h === 0, "Should have 0 passed stage 2 events in 24h window (since Case C is 26h ago)");

  // Run pruning
  pruneMetrics();

  // Verify counts after pruning
  const countsAfter = getMetricsCounts();
  const getRawCount = () => {
    const r = getMetricsCounts();
    return r.firehoseCount24h + r.passedStage1Count24h + r.passedStage2Count24h;
  };
  assert(getRawCount() === 80, "Metrics log table should have exactly 80 entries after pruning (20 older entries deleted)");
  
  // Verify stats publishing updates Firestore mock with correct throughput counts
  latestStats = null;
  await triggerHeartbeat();
  assert(latestStats !== null, "triggerHeartbeat should publish stats");
  assert(latestStats.firehoseCount1h === 50, "Published firehoseCount1h should be 50");
  assert(latestStats.passedStage1Count24h === 30, "Published passedStage1Count24h should be 30");
  assert(latestStats.passedStage2Count24h === 0, "Published passedStage2Count24h should be 0");

  // ----------------------------------------------------
  // Scenario 7.11: User Engagement Signal Capture
  // ----------------------------------------------------
  console.log("\nScenario 7.11: User Engagement Signal Capture...");

  clearOutbox();

  // Test Action 1 (User Action Capture)
  const engagementPostUri = "at://did:plc:creator123/app.bsky.feed.post/engagement123";
  
  // Mock fetch for AppView XRPC getPosts
  global.fetch = async (url: any, init?: any) => {
    if (url.toString().includes("getPosts") && url.toString().includes(encodeURIComponent(engagementPostUri))) {
      return {
        ok: true,
        json: async () => ({
          posts: [{
            uri: engagementPostUri,
            cid: "bafyengagementcid",
            author: {
              did: "did:plc:creator123",
              handle: "creator.bsky.social"
            },
            record: {
              text: "Post engaged by user",
              createdAt: "2026-07-02T10:00:00.000Z"
            }
          }]
        })
      } as Response;
    }
    return originalFetch(url, init);
  };

  const likeMsg = {
    did: "did:plc:owner123", // USER_DID
    time_us: 1715623470000000,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.like",
      rkey: "3kslikerkey",
      record: {
        $type: "app.bsky.feed.like",
        subject: {
          uri: engagementPostUri,
          cid: "bafyengagementcid"
        },
        createdAt: "2026-07-02T10:00:00.000Z"
      }
    }
  };

  writtenPosts.length = 0;
  await handleCommit(likeMsg, "did:plc:owner123");
  await processOutbox();

  assert(writtenPosts.length === 1, "Should resolve and write engagement post to outbox/Firestore");
  assert(writtenPosts[0].uri === engagementPostUri, "URI of logged engagement post should match target");
  assert(writtenPosts[0].feedback === "interacted", "Logged engagement post feedback should be 'interacted'");
  assert(writtenPosts[0].matchRules.includes("user_engagement_signal"), "matchRules should contain 'user_engagement_signal'");
  assert(writtenPosts[0].version === "v1.0.0", "version should match current version (v1.0.0)");

  // Test Action 2 (Existing Post Engagement)
  const existingPostDoc = {
    uri: "at://did:plc:creator123/app.bsky.feed.post/existing123",
    cid: "bafyexistingcid",
    authorDid: "did:plc:creator123",
    authorHandle: "creator.bsky.social",
    text: "Existing post to engage with",
    createdAt: "2026-07-02T11:00:00.000Z",
    matchedAt: "2026-07-02T11:00:00.000Z",
    relevanceScore: 80,
    relevanceExplanation: "relevant",
    matchRules: ["keyword:atproto"],
    isDeleted: false,
    facets: [],
    mediaEmbed: { type: "none" },
    parentContext: null,
    quotedContext: null,
    version: "v1.0.0"
  };

  const { addLocalPost: dbAddLocalPost } = require("./db");
  dbAddLocalPost(existingPostDoc);

  const repostMsgOwner = {
    did: "did:plc:owner123", // USER_DID
    time_us: 1715623480000000,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.repost",
      rkey: "3ksrepostrkey",
      record: {
        $type: "app.bsky.feed.repost",
        subject: {
          uri: existingPostDoc.uri,
          cid: "bafyexistingcid"
        },
        createdAt: "2026-07-02T11:05:00.000Z"
      }
    }
  };

  writtenPosts.length = 0;
  await handleCommit(repostMsgOwner, "did:plc:owner123");
  await processOutbox();

  assert(writtenPosts.length === 1, "Should update the existing post feedback and push to Firestore");
  assert(writtenPosts[0].uri === existingPostDoc.uri, "URI of updated post should match");
  assert(writtenPosts[0].feedback === "interacted", "Updated post feedback should be 'interacted'");
  assert(writtenPosts[0].matchRules.includes("user_engagement_signal"), "Updated post matchRules should contain 'user_engagement_signal'");

  global.fetch = originalFetch;

  // ----------------------------------------------------
  // Scenario 7.12: Version & Deployment Shift Verification
  // ----------------------------------------------------
  console.log("\nScenario 7.12: Version & Deployment Shift Verification...");

  assert(writtenPosts[0].version === "v1.0.0", "Written post should have v1.0.0 version attribute");

  let queryCount = 0;
  let loggedDeployments: any[] = [];

  setMockDeploymentHandlers(
    async () => {
      queryCount++;
      return loggedDeployments;
    },
    async (dep) => {
      loggedDeployments.unshift(dep);
    }
  );

  process.env.SYSTEM_VERSION = "v1.1.0";
  process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
  process.env.BATCH_INTERVAL_SECONDS = "300";
  process.env.BATCH_EVAL_CAP = "100";
  process.env.AI_FILTERING_ENABLED = "true";

  await trackDeploymentShift();
  assert(queryCount === 1, "Should query deployments collection");
  assert(loggedDeployments.length === 1, "Should log a new deployment document");
  assert(loggedDeployments[0].version === "v1.1.0", "New deployment version should be v1.1.0");

  queryCount = 0;
  await trackDeploymentShift();
  assert(queryCount === 1, "Should query deployments collection again");
  assert(loggedDeployments.length === 1, "Should NOT write a new deployment because settings are identical");

  process.env.BATCH_EVAL_CAP = "200";
  queryCount = 0;
  await trackDeploymentShift();
  assert(queryCount === 1, "Should query deployments collection third time");
  assert(loggedDeployments.length === 2, "Should log another deployment document due to BATCH_EVAL_CAP change");
  assert(loggedDeployments[0].batchEvalCap === 200, "Logged deployment cap should be updated to 200");

  process.env.SYSTEM_VERSION = "v1.0.0";
  process.env.BATCH_EVAL_CAP = "100";

  // ----------------------------------------------------
  // Cleanup & Summary
  // ----------------------------------------------------
  cleanTestDb();

  console.log(`\n=== Test Suite Complete ===`);
  console.log(`Passed: ${testsPassedCount} | Failed: ${testsFailedCount}`);

  if (testsFailedCount > 0) {
    process.exit(1);
  } else {
    console.log("\n🚀 All tests passed successfully!");
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  cleanTestDb();
  process.exit(1);
});
