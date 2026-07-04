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
  queryProcessingFailures
} from "./db";
import { setMockEvaluator } from "./gemini";
import { setMockDbHandlers, processOutbox, stopOutboxWorker, getPostId } from "./firestore";
import { handleCommit } from "./jetstream";

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

  setMockEvaluator(async (text, handle, parentContext, quotedContext, matchRules) => {
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
  });

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

  // Restore fetch
  global.fetch = originalFetch;

  const failures = queryProcessingFailures("context_fetch");
  assert(failures.length > 0, "A context_fetch failure should be logged in processing_failures");
  assert(failures[0].error_message.includes("AppView API request timeout: HTTP 504"), "Error message should contain HTTP 504 info");
  assert(failures[0].raw_payload.includes("at://did:plc:parent/app.bsky.feed.post/999"), "Raw payload should contain the reply URI");

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
