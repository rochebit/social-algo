import * as admin from "firebase-admin";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  addLocalPost,
  updateLocalPostFeedback,
  updateLocalPostDeletedStatus,
  queueOutboxWrite,
  queueOutboxDelete,
  getPendingOutboxItems,
  updateOutboxItemStatus,
  deleteOutboxItem,
  OutboxItem,
  logProcessingFailure
} from "./db";

// Define Firestore interfaces
export interface PostContext {
  uri: string;
  authorHandle: string;
  text: string;
}

export interface MediaEmbed {
  type: "images" | "external" | "video" | "none";
  images?: { thumbUrl: string; fullsizeUrl: string; alt: string }[];
  externalLink?: { uri: string; title: string; description: string; thumbUrl?: string };
  video?: { playlistUrl: string; thumbnailUrl: string };
}

export interface ParsedFacet {
  start: number;
  end: number;
  type: "link" | "tag" | "mention";
  uri?: string;
  tag?: string;
  did?: string;
}

export interface PostDocument {
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  createdAt: string;
  matchedAt: string;
  relevanceScore: number;
  relevanceExplanation: string;
  matchRules: string[];
  feedback: string | null;
  feedbackAt: string | null;
  isDeleted: boolean;
  facets: ParsedFacet[];
  mediaEmbed: MediaEmbed;
  parentContext: PostContext | null;
  quotedContext: PostContext | null;
}

export interface FeedbackLogDocument {
  postId: string;
  postUri: string;
  authorDid: string;
  feedback: string;
  submittedAt: string;
  userEmail: string;
}

const DATA_DIR = path.resolve(__dirname, "../data");
const FEEDBACK_LOG_PATH = path.join(DATA_DIR, "feedback_archive.jsonl");

let firestoreDb: admin.firestore.Firestore | null = null;
let mockWriteHandler: ((post: any) => Promise<void>) | null = null;
let mockDeleteHandler: ((uri: string) => Promise<void>) | null = null;

export function setMockDbHandlers(
  writeFn: typeof mockWriteHandler,
  deleteFn: typeof mockDeleteHandler
) {
  mockWriteHandler = writeFn;
  mockDeleteHandler = deleteFn;
}

export function initFirestore(): admin.firestore.Firestore {
  if (firestoreDb) return firestoreDb;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (credentialsPath && fs.existsSync(credentialsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
      if (creds && creds.project_id) {
        console.log(`Initializing Firebase Admin using credentials from: ${credentialsPath}`);
        admin.initializeApp({
          credential: admin.credential.cert(creds),
          projectId: projectId
        });
      } else {
        console.log(`Firebase credentials file at ${credentialsPath} is empty/invalid. Falling back to default initialization.`);
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        admin.initializeApp({
          projectId: projectId || "mock-project"
        });
      }
    } catch (err) {
      console.warn(`Error parsing Firebase credentials at ${credentialsPath}:`, err);
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      admin.initializeApp({
        projectId: projectId || "mock-project"
      });
    }
  } else {
    // Attempt application default credentials or emulator fallback
    console.log("Initializing Firebase Admin using application default credentials/emulator");
    admin.initializeApp({
      projectId: projectId || "mock-project"
    });
  }

  firestoreDb = admin.firestore();
  return firestoreDb;
}

/**
 * Computes SHA-256 hash of post URI.
 */
export function getPostId(uri: string): string {
  return crypto.createHash("sha256").update(uri).digest("hex");
}

/**
 * Write a filtered post to Firestore.
 */
export async function writePost(post: Omit<PostDocument, "feedback" | "feedbackAt">): Promise<void> {
  // Write to local SQLite database long-term
  try {
    addLocalPost(post);
  } catch (err) {
    console.error(`Failed to insert post into local SQLite database: ${post.uri}`, err);
  }

  // Queue write action in local outbox
  try {
    const docData: PostDocument = {
      ...post,
      feedback: null,
      feedbackAt: null
    };
    queueOutboxWrite(post.uri, docData);
  } catch (err) {
    console.error(`Failed to queue post write in outbox: ${post.uri}`, err);
    throw err;
  }
}

/**
 * Soft-delete a post in Firestore.
 */
export async function softDeletePost(uri: string): Promise<void> {
  // Sync delete status in local SQLite database
  try {
    updateLocalPostDeletedStatus(uri, true);
  } catch (err) {
    console.error(`Failed to update post delete status in local SQLite: ${uri}`, err);
  }

  // Queue delete action in local outbox
  try {
    queueOutboxDelete(uri);
  } catch (err) {
    console.error(`Failed to queue post delete in outbox: ${uri}`, err);
    throw err;
  }
}

/**
 * Read existing archived URIs from feedback_archive.jsonl.
 */
function getArchivedUris(): Set<string> {
  const archived = new Set<string>();
  if (!fs.existsSync(FEEDBACK_LOG_PATH)) {
    return archived;
  }

  const lines = fs.readFileSync(FEEDBACK_LOG_PATH, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      if (data.postUri) {
        archived.add(data.postUri);
      }
    } catch {
      // Ignore parsing errors of old/broken lines
    }
  }

  return archived;
}

/**
 * Query Firestore for rated posts, archive them locally to jsonl, sync to SQLite, and delete them from Firestore.
 */
export async function archiveFeedbackLogs(): Promise<number> {
  console.log("Running scheduled feedback log backup and Firestore cleanup...");
  const db = initFirestore();

  const archivedUris = getArchivedUris();
  let appendCount = 0;

  try {
    // Query all posts that have feedback
    const snapshot = await db.collection("posts").where("feedback", "!=", null).get();
    
    if (snapshot.empty) {
      console.log("No rated posts found in Firestore to clean up.");
      return 0;
    }

    const writeStream = fs.createWriteStream(FEEDBACK_LOG_PATH, { flags: "a" });

    for (const doc of snapshot.docs) {
      const data = doc.data() as PostDocument;
      if (!data.uri) continue;

      // 1. Sync rating to SQLite (in case real-time listener missed it)
      try {
        updateLocalPostFeedback(data.uri, data.feedback, data.feedbackAt);
      } catch (err) {
        console.error(`Failsafe SQLite update failed for: ${data.uri}`, err);
      }

      // 2. Append to JSONL log if not already there
      if (!archivedUris.has(data.uri)) {
        const logEntry: FeedbackLogDocument = {
          postId: getPostId(data.uri),
          postUri: data.uri,
          authorDid: data.authorDid,
          feedback: data.feedback || "unknown",
          submittedAt: data.feedbackAt || new Date().toISOString(),
          userEmail: process.env.OWNER_EMAIL || "rochebit@gmail.com"
        };

        writeStream.write(JSON.stringify(logEntry) + "\n");
        appendCount++;
      }

      // 3. Delete from Firestore to free cloud database space
      try {
        const postId = getPostId(data.uri);
        await db.collection("posts").doc(postId).delete();
      } catch (delErr) {
        console.error(`Failed to delete rated post from Firestore: ${data.uri}`, delErr);
      }
    }

    writeStream.end();
    console.log(`Archived and cleared ${snapshot.docs.length} rated posts from Firestore.`);
  } catch (error) {
    console.error("Error archiving feedback logs:", error);
  }

  return appendCount;
}


/**
 * Start the 24-hour backup interval loop.
 */
export function startArchiverScheduler(): void {
  // Run once on startup after 10 seconds to catch up
  setTimeout(async () => {
    await archiveFeedbackLogs();
  }, 10000);

  // Set interval to repeat every 24 hours
  const INTERVAL_24H = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    await archiveFeedbackLogs();
  }, INTERVAL_24H);
}

let syncTimeout: NodeJS.Timeout | null = null;
let isSyncing = false;

/**
 * Processes all pending outbox queue items in order.
 */
export async function processOutbox(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const items = getPendingOutboxItems();
    for (const item of items) {
      try {
        if (item.action === "write") {
          const payload = JSON.parse(item.payload || "{}");
          if (mockWriteHandler) {
            await mockWriteHandler(payload);
          } else {
            const db = initFirestore();
            await db.collection("posts").doc(item.post_id).set(payload, { merge: true });
          }
        } else if (item.action === "delete") {
          if (mockDeleteHandler) {
            await mockDeleteHandler(item.uri);
          } else {
            const db = initFirestore();
            await db.collection("posts").doc(item.post_id).set({ isDeleted: true }, { merge: true });
          }
        }
        // Success: remove from local outbox queue
        deleteOutboxItem(item.post_id);
      } catch (err: any) {
        console.error(`Sync error processing outbox item ${item.post_id}:`, err);
        const newRetryCount = item.retry_count + 1;
        updateOutboxItemStatus(item.post_id, "failed", newRetryCount);
        
        // Log the sync error (Section 9.2)
        try {
          const rawPayload = JSON.stringify({
            post_id: item.post_id,
            action: item.action,
            payload: item.payload
          });
          logProcessingFailure("firestore_sync", rawPayload, err.message || String(err));
        } catch (logErr) {
          console.error("Failed to insert sync failure into DB", logErr);
        }

        // Throw to propagate failure and trigger worker backoff
        throw err;
      }
    }
  } finally {
    isSyncing = false;
  }
}

/**
 * Starts the continuous outbox queue sync worker loop.
 */
export function startOutboxWorker(): void {
  let consecutiveFailures = 0;

  async function runTick() {
    try {
      await processOutbox();
      consecutiveFailures = 0;
      syncTimeout = setTimeout(runTick, 5000); // Check again in 5 seconds
    } catch (err) {
      consecutiveFailures++;
      // delay = min(5000 * (1.5 ^ consecutiveFailures), 300000) + jitter
      const baseDelay = Math.min(5000 * Math.pow(1.5, consecutiveFailures), 300000);
      const jitter = Math.random() * 200 - 100; // ±100ms
      const delay = Math.max(1000, baseDelay + jitter);
      console.warn(`Outbox sync worker backoff: retrying in ${Math.round(delay)}ms (consecutive failures: ${consecutiveFailures})`);
      syncTimeout = setTimeout(runTick, delay);
    }
  }

  // Initial execution run
  runTick();
}

/**
 * Stops the outbox sync worker background loop.
 */
export function stopOutboxWorker(): void {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
}

let mockStatsHandler: ((stats: any) => Promise<void>) | null = null;

export function setMockStatsHandler(fn: typeof mockStatsHandler): void {
  mockStatsHandler = fn;
}

export async function publishStats(stats: {
  lastActive: string;
  lastBatchTime: string;
  queueSize: number;
  geminiFailureCount24h: number;
  lastBatchProcessedCount: number;
  lastBatchSuccessCount: number;
  lastBatchRelevantCount: number;
  lastError: string | null;
  backendStatus: string;
}): Promise<void> {
  if (mockStatsHandler) {
    await mockStatsHandler(stats);
    return;
  }
  try {
    const db = initFirestore();
    await db.collection("stats").doc("backend").set(stats, { merge: true });
  } catch (err) {
    console.error("Failed to publish backend stats to Firestore:", err);
  }
}
