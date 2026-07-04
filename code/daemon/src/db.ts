import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "node:crypto";

const DATA_DIR = path.resolve(__dirname, "../data");
const DB_NAME = process.env.NODE_ENV === "test" ? "test_network_graph.db" : "network_graph.db";
const DB_PATH = path.join(DATA_DIR, DB_NAME);

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db: DatabaseSync;

export function initDb(): void {
  db = new DatabaseSync(DB_PATH);

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL;");

  // Schema per spec Section 4.1 — only first_degree_follows and posts_outbox
  db.exec(`
    CREATE TABLE IF NOT EXISTS first_degree_follows (
        rkey TEXT PRIMARY KEY,
        followed_did TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS posts_outbox (
        post_id TEXT PRIMARY KEY,
        uri TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
        uri TEXT PRIMARY KEY,
        cid TEXT,
        author_did TEXT,
        author_handle TEXT,
        text TEXT,
        created_at TEXT,
        matched_at TEXT,
        relevance_score INTEGER,
        relevance_explanation TEXT,
        match_rules TEXT,
        feedback TEXT,
        feedback_at TEXT,
        is_deleted BOOLEAN DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS processing_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        raw_payload TEXT,
        error_message TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posts_feedback ON posts (feedback);
    CREATE INDEX IF NOT EXISTS idx_posts_matched ON posts (matched_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON posts_outbox (status);
  `);
}

/**
 * Checks if a DID is in the 1st-degree follows list (Section 3.1).
 */
export function isFollowed(did: string): boolean {
  const row = db.prepare("SELECT 1 FROM first_degree_follows WHERE followed_did = ?").get(did);
  return !!row;
}

/**
 * Returns true if the first_degree_follows table has any rows.
 */
export function hasFirstDegreeFollows(): boolean {
  const result = db
    .prepare("SELECT COUNT(*) as count FROM first_degree_follows")
    .get() as { count: number } | undefined;
  return result ? result.count > 0 : false;
}

/**
 * Inserts or replaces a 1st-degree follow record (Section 4.3.1).
 */
export function addFirstDegreeFollow(rkey: string, followedDid: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO first_degree_follows (rkey, followed_did) VALUES (?, ?)"
  ).run(rkey, followedDid);
}

/**
 * Removes a 1st-degree follow by rkey. Returns the unfollowed DID, or null.
 * (Section 4.3.2)
 */
export function removeFirstDegreeFollowByRkey(rkey: string): string | null {
  const row = db
    .prepare("SELECT followed_did FROM first_degree_follows WHERE rkey = ?")
    .get(rkey) as { followed_did: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM first_degree_follows WHERE rkey = ?").run(rkey);
  return row.followed_did;
}

/**
 * Returns all stored 1st-degree follow DIDs.
 */
export function getFirstDegreeFollows(): string[] {
  const rows = db
    .prepare("SELECT followed_did FROM first_degree_follows")
    .all() as { followed_did: string }[];
  return rows.map((r) => r.followed_did);
}

let mockFetchAllFollows: ((actorDid: string) => Promise<string[]>) | null = null;

export function setMockFetchAllFollows(fn: typeof mockFetchAllFollows) {
  mockFetchAllFollows = fn;
}

/**
 * Paginates through app.bsky.graph.getFollows and returns all followed DIDs.
 */
export async function fetchAllFollows(actorDid: string): Promise<string[]> {
  if (mockFetchAllFollows) {
    return mockFetchAllFollows(actorDid);
  }
  const follows: string[] = [];
  let cursor: string | undefined = undefined;

  try {
    do {
      let url = `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?actor=${encodeURIComponent(actorDid)}&limit=100`;
      if (cursor) {
        url += `&cursor=${encodeURIComponent(cursor)}`;
      }
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`Failed to fetch follows for ${actorDid}: ${res.statusText}`);
        break;
      }
      const data = (await res.json()) as { follows: { did: string }[]; cursor?: string };
      if (data.follows) {
        for (const item of data.follows) {
          if (item.did) follows.push(item.did);
        }
      }
      cursor = data.cursor;
    } while (cursor);
  } catch (error) {
    console.error(`Error querying getFollows for ${actorDid}:`, error);
  }

  return follows;
}

/**
 * Performs a startup sync of 1st-degree follows from the Bluesky API (Section 4.2).
 */
export async function syncNetworkGraph(userDid: string): Promise<void> {
  console.log(`Starting startup graph sync for user: ${userDid}`);
  const firstDegree = await fetchAllFollows(userDid);
  console.log(`Found ${firstDegree.length} first-degree follows.`);

  try {
    db.exec("BEGIN TRANSACTION;");
    db.prepare("DELETE FROM first_degree_follows").run();

    const insertFirst = db.prepare(
      "INSERT INTO first_degree_follows (rkey, followed_did) VALUES (?, ?)"
    );
    firstDegree.forEach((did, idx) => {
      insertFirst.run(`sync:${idx}`, did);
    });

    db.exec("COMMIT;");
  } catch (e) {
    db.exec("ROLLBACK;");
    console.error("Failed transaction rebuilding 1st-degree follows:", e);
    throw e;
  }

  console.log("Startup social graph sync completed.");
}

// -----------------------------------------------------------------------
// Local posts cache (long-term SQLite storage)
// -----------------------------------------------------------------------

/**
 * Inserts or replaces a matched post in the local SQLite posts table.
 */
export function addLocalPost(post: {
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
  isDeleted: boolean;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO posts (
      uri, cid, author_did, author_handle, text, created_at, matched_at,
      relevance_score, relevance_explanation, match_rules, feedback, feedback_at, is_deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(
    post.uri,
    post.cid,
    post.authorDid,
    post.authorHandle,
    post.text,
    post.createdAt,
    post.matchedAt,
    post.relevanceScore,
    post.relevanceExplanation,
    JSON.stringify(post.matchRules || []),
    post.isDeleted ? 1 : 0
  );
}

/**
 * Updates the feedback fields on a local post record.
 */
export function updateLocalPostFeedback(
  uri: string,
  feedback: string | null,
  feedbackAt: string | null
): void {
  db.prepare("UPDATE posts SET feedback = ?, feedback_at = ? WHERE uri = ?").run(
    feedback,
    feedbackAt,
    uri
  );
}

/**
 * Updates a post's deletion status in the local SQLite cache.
 */
export function updateLocalPostDeletedStatus(uri: string, isDeleted: boolean): void {
  db.prepare("UPDATE posts SET is_deleted = ? WHERE uri = ?").run(isDeleted ? 1 : 0, uri);
}

/**
 * Test helper: query a post from the SQLite posts table.
 */
export function queryLocalPost(uri: string): any {
  return db.prepare("SELECT * FROM posts WHERE uri = ?").get(uri);
}

// -----------------------------------------------------------------------
// Outbox queue (SQLite → Firestore sync)
// -----------------------------------------------------------------------

/**
 * Computes the SHA-256 hex hash of a post URI to use as Firestore document ID.
 */
function getPostId(uri: string): string {
  return crypto.createHash("sha256").update(uri).digest("hex");
}

/**
 * Queues a post write operation in the local outbox.
 */
export function queueOutboxWrite(uri: string, payload: any): void {
  const postId = getPostId(uri);
  db.prepare(`
    INSERT OR REPLACE INTO posts_outbox (post_id, uri, action, payload, status, retry_count, created_at)
    VALUES (?, ?, 'write', ?, 'pending', 0, ?)
  `).run(postId, uri, JSON.stringify(payload), new Date().toISOString());
}

/**
 * Queues a post soft-delete operation in the local outbox.
 */
export function queueOutboxDelete(uri: string): void {
  const postId = getPostId(uri);
  db.prepare(`
    INSERT OR REPLACE INTO posts_outbox (post_id, uri, action, payload, status, retry_count, created_at)
    VALUES (?, ?, 'delete', NULL, 'pending', 0, ?)
  `).run(postId, uri, new Date().toISOString());
}

export interface OutboxItem {
  post_id: string;
  uri: string;
  action: "write" | "delete";
  payload: string | null;
  status: string;
  retry_count: number;
  created_at: string;
}

/**
 * Retrieves all pending or failed outbox items, ordered by creation time ASC.
 */
export function getPendingOutboxItems(): OutboxItem[] {
  return db
    .prepare(`
      SELECT post_id, uri, action, payload, status, retry_count, created_at
      FROM posts_outbox
      WHERE status = 'pending' OR status = 'failed'
      ORDER BY created_at ASC
    `)
    .all() as unknown as OutboxItem[];
}

/**
 * Updates the status and retry count of an outbox item on failure.
 */
export function updateOutboxItemStatus(
  postId: string,
  status: "pending" | "failed",
  retryCount: number
): void {
  db.prepare(`
    UPDATE posts_outbox SET status = ?, retry_count = ? WHERE post_id = ?
  `).run(status, retryCount, postId);
}

/**
 * Removes a successfully synced outbox item.
 */
export function deleteOutboxItem(postId: string): void {
  db.prepare("DELETE FROM posts_outbox WHERE post_id = ?").run(postId);
}

/**
 * Test helper: query an outbox item from SQLite.
 */
export function queryOutboxItem(postId: string): any {
  return db.prepare("SELECT * FROM posts_outbox WHERE post_id = ?").get(postId);
}

/**
 * Logs a processing failure into SQLite (Section 9.2).
 */
export function logProcessingFailure(
  eventType: string,
  rawPayload: string | null,
  errorMessage: string
): void {
  db.prepare(`
    INSERT INTO processing_failures (event_type, raw_payload, error_message, created_at)
    VALUES (?, ?, ?, ?)
  `).run(eventType, rawPayload, errorMessage, new Date().toISOString());
}

/**
 * Test helper: queries processing failures.
 */
export function queryProcessingFailures(eventType?: string): any[] {
  if (eventType) {
    return db.prepare("SELECT * FROM processing_failures WHERE event_type = ? ORDER BY created_at DESC").all(eventType);
  }
  return db.prepare("SELECT * FROM processing_failures ORDER BY created_at DESC").all();
}

