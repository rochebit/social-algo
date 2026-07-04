# Ingestion & Filtering Pipeline Specification

This document details the step-by-step logic for the real-time Jetstream consumer, the dynamic network graph sync, the local SQLite outbox queue, the fast rule-based pre-filter, the parent/quote context crawler, the liked/reposted content resolver, the Gemini LLM relevance evaluation workflow, error handling for processing failures, and the simple feedback archive mechanism.

---

## 1. Configuration Settings

The Home Server daemon loads configuration parameters from a local environment file (`.env`).

| Configuration Key | Data Type | Default Value | Description |
|---|---|---|---|
| **`AI_FILTERING_ENABLED`** | boolean | `true` | When `false`, posts that match the pre-filter bypass Gemini evaluation and are written to the outbox immediately. |
| **`GEMINI_API_KEY`** | string | `""` | API key used for the Gemini relevance evaluation. Required if `AI_FILTERING_ENABLED` is `true`. |
| **`DATETIME_FORMAT`** | string | `"ISO-8601"` | Standard format for all database timestamps (UTC string, e.g., `YYYY-MM-DDTHH:mm:ss.sssZ`). |
| **`USER_DID`** | string | `""` | The ATProto Decentralized Identifier (DID) of the owner (used to monitor follow/like/repost events from the firehose). |

---

## 2. Ingestion Flow (Jetstream Consumer)

The Home Server daemon maintains a persistent WebSocket connection to subscribe to posts, follows, reposts, and likes.

### 2.1 Connection & Handshake
- **Target URL:** `wss://jetstream2.us-east.bsky.network/subscribe`
- **Query Parameters:**
  - `wantedCollections=app.bsky.feed.post`
  - `wantedCollections=app.bsky.graph.follow`
  - `wantedCollections=app.bsky.feed.repost`
  - `wantedCollections=app.bsky.feed.like`
- **Reconnection & Cursor Management:**
  - The daemon must track the `seq` integer field from incoming messages and save the latest sequence number locally to a state file (`cursor.json`) every 5 seconds.
  - On disconnect, the daemon must implement exponential backoff reconnection (start at 1s, double up to a maximum of 60s, with a random jitter of ±100ms).
  - When reconnecting, append the `cursor` query parameter with the last saved `seq` value to catch up on missed messages:
    `wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&wantedCollections=app.bsky.graph.follow&wantedCollections=app.bsky.feed.repost&wantedCollections=app.bsky.feed.like&cursor={seq}`

### 2.2 Firestore Document ID Generation Rule
To avoid duplicate posts in Firestore, the daemon must generate a predictable, unique document ID (`postId`) from the ATProto URI:
- **Rule:** Apply the `SHA-256` hashing algorithm to the post URI string (e.g., `at://did:plc:123/app.bsky.feed.post/456`), and use the resulting hex string (64 characters) as the Firestore Document ID.

### 2.3 Event Parsing & Operation Routing
For every message received, the daemon checks the collection type and routes the payload:

1. **`app.bsky.feed.post` Collections:**
   - **Create (`commit.operation == "create"`):** Route to **Stage 1: Pre-Filtering**.
   - **Delete (`commit.operation == "delete"`):** Construct the post URI (`at://{did}/{collection}/{rkey}`), calculate the Firestore document ID, and write a delete action to the local outbox.
2. **`app.bsky.graph.follow` Collections:**
   - Route to **Section 4: Network Graph Synchronization Pipeline**.
3. **`app.bsky.feed.repost` & `app.bsky.feed.like` Collections:**
   - **Create (`commit.operation == "create"`):** If the actor `did` is in `first_degree_follows` (or matches `USER_DID`), route to **Section 6: Liked & Reposted Content Resolver**.
   - **Delete:** Ignore.
4. **Other Operations:**
   - Discard immediately.

---

## 3. Stage 1: Rule-Based & Network Pre-Filtering

To minimize LLM token usage and latency, posts must pass a rule-based pre-filter. A post proceeds to evaluation if it satisfies **any** of the following conditions:

### 3.1 Network Graph Match (Bypass Keywords)
- The post `authorDid` matches an entry in your local **1st-Degree** follows database (someone you follow).
- **Rule:** Posts matching this condition **bypass the keyword and regex filter rules completely** and are sent directly to AI evaluation (Stage 2).

### 3.2 Keyword & Regex Matching (For General Network Posts)
If the author is not in your network graph, the post text must match any of the following case-insensitive regex patterns:
- `\batproto\b` (AT Protocol)
- `\bbluesky\s+dev\b` (Bluesky Dev)
- `\blexicon\b` (ATProto Lexicon definitions)
- `\bpds\b` (Personal Data Server)
- `\bxrpc\b` (ATProto RPC protocol)
- `\bappview\b` (AppView indexing)
- `\bdid:plc:\w+\b` (DIDs)
- `\bat://\w+\b` (AT URI scheme)
- `\bfederat(e|ion)\b` (Federation context)
- `\bself-host(ing|ed)?\b` (Self-hosting)

### 3.3 Curated Whitelist Matching
- The post `authorDid` matches an entry in your locally stored list of curated developers (`curated_devs.json`), or is a reply to/repost of someone on that list.

---

## 4. SQLite Database Specifications (`network_graph.db`)

The daemon manages local state using a single-file SQLite database.

### 4.1 Schema
```sql
-- 1st-degree follows only
CREATE TABLE first_degree_follows (
    rkey TEXT PRIMARY KEY,
    followed_did TEXT UNIQUE
);

-- Outbox queue table
CREATE TABLE posts_outbox (
    post_id TEXT PRIMARY KEY,       -- SHA-256 hash of post URI
    uri TEXT NOT NULL,
    action TEXT NOT NULL,          -- 'write' or 'delete'
    payload TEXT,                  -- JSON string of document fields (NULL for 'delete')
    status TEXT DEFAULT 'pending', -- 'pending', 'failed'
    retry_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL       -- ISO-8601 UTC string
);

-- Processing failures table
CREATE TABLE processing_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,      -- 'post_ingest', 'follow_ingest', 'like_ingest', 'repost_ingest', 'context_fetch', 'gemini_call', 'firestore_sync'
    raw_payload TEXT,              -- Stringified Jetstream or API JSON payload
    error_message TEXT NOT NULL,   -- Description of exception
    created_at TEXT NOT NULL       -- ISO-8601 UTC string
);
```

### 4.2 Startup Sync Logic
On initial startup (or if the database is unpopulated):
1. **1st-Degree Sync:** Call the ATProto XRPC endpoint `app.bsky.graph.getFollows` for your `USER_DID`. Store all returned DIDs in `first_degree_follows`.

### 4.3 Real-Time Firehose Syncing (Jetstream events)
As follow events arrive, update the local SQLite database in real-time:

#### 4.3.1 Create Operations (`commit.operation == "create"`)
When you click follow on Bluesky:
* **Check:** If `did == USER_DID` (the event actor is you):
  1. Write `rkey` and `subject` (the followed user's DID) into `first_degree_follows`.

#### 4.3.2 Delete Operations (`commit.operation == "delete"`)
When you unfollow:
* **Check:** If `did == USER_DID` (the event actor is you):
  1. Find the `followed_did` in `first_degree_follows` matching the deleted `rkey`.
  2. Delete that row from `first_degree_follows`.

---

## 5. Thread & Quote Context Retrieval

If an ingested post passes Stage 1, the daemon must check for external post references and resolve their contents prior to LLM evaluation.

### 5.1 Parent Post Resolution
- **Trigger:** The post record contains a `reply` object containing `reply.parent.uri`.
- **Action:** The daemon calls the public AppView endpoint to fetch the parent post metadata:
  ```http
  GET https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris={reply.parent.uri}
  ```
- **Parsing:** Generate the `parentContext` object: `{ uri, authorHandle, text }`. If the fetch fails, set to `null`.

### 5.2 Quoted Post Resolution
- **Trigger:** The post record contains an `embed` object where `embed.$type == "app.bsky.embed.record"` containing `embed.record.uri`.
- **Action:** Call the same endpoint:
  ```http
  GET https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris={embed.record.uri}
  ```
- **Parsing:** Generate the `quotedContext` object: `{ uri, authorHandle, text }`. If the fetch fails, set to `null`.

---

## 6. Liked & Reposted Content Resolver

When someone you follow likes or reposts (boosts) a post, that target post is resolved and routed directly to evaluation.

### 6.1 Event Validation
- **Trigger:** A `create` event is received in `app.bsky.feed.repost` or `app.bsky.feed.like`.
- **Validation:** Check if the event actor `did` is present in your local `first_degree_follows` table (or matches `USER_DID`).
- **If Valid:** Extract the target post's URI: `subjectUri = commit.record.subject.uri`.

### 6.2 Target Post Content Fetching
- **Action:** Query the public AppView endpoint:
  ```http
  GET https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris={subjectUri}
  ```
- **Parsing:** Extract the post contents (text, author DID, author handle, created timestamp, facets, and media embeds).
- **Match Rule Logging:** Add the string `"repost:{actorHandle}"` or `"like:{actorHandle}"` to the post's `matchRules` metadata array.
- **Routing:** Route the fully constructed post payload **bypassing keyword rules** directly to Stage 2 (AI Relevance Evaluation) for final validation.

---

## 7. Rich Text Facets & Media Embed Processing

To ensure links and media display correctly without downloading content to the home server, the daemon parses facets and constructs public CDN hotlink URLs at ingestion time.

### 7.1 Facets Parsing (Links & Mentions)
If the Jetstream record contains a `facets` array, parse each entry:
1. Extract the byte indexes: `start` and `end` from `index.byteStart` and `index.byteEnd`.
2. Inspect the feature type:
   - **Link (`$type == "app.bsky.richtext.facet#link"`):** Save as `{ "start": start, "end": end, "type": "link", "uri": feature.uri }`.
   - **Tag (`$type == "app.bsky.richtext.facet#tag"`):** Save as `{ "start": start, "end": end, "type": "tag", "tag": feature.tag }`.
   - **Mention (`$type == "app.bsky.richtext.facet#mention"`):** Save as `{ "start": start, "end": end, "type": "mention", "did": feature.did }`.

### 7.2 Media Embed hotlinking
If the Jetstream record contains an `embed` object, inspect the type and map it to `mediaEmbed` fields using public CDN structures:

#### 7.2.1 Images (`embed.$type == "app.bsky.embed.images"`)
- Iterate the `images` array.
- For each image blob containing a reference link `image.ref.$link`:
  - **Construct `thumbUrl`:**
    `https://cdn.bsky.app/img/feed_thumbnail/plain/{authorDid}/{image.ref.$link}@jpeg`
  - **Construct `fullsizeUrl`:**
    `https://cdn.bsky.app/img/feed_fullsize/plain/{authorDid}/{image.ref.$link}@jpeg`
  - Save to Firestore under `mediaEmbed.images` array.

#### 7.2.2 External Link Cards (`embed.$type == "app.bsky.embed.external"`)
- Extract `external` metadata: `uri`, `title`, `description`.
- If a thumbnail blob reference exists under `external.thumb.ref.$link`:
  - **Construct `thumbUrl`:**
    `https://cdn.bsky.app/img/feed_thumbnail/plain/{authorDid}/{external.thumb.ref.$link}@jpeg`
  - Save to Firestore under `mediaEmbed.externalLink`.

#### 7.2.3 Videos (`embed.$type == "app.bsky.embed.video"`)
- Extract the video blob CID: `embed.video.ref.$link`.
- **Construct `playlistUrl` (HLS master playlist):**
  `https://video.cdn.bsky.app/hls/{authorDid}/{video_blob_cid}/playlist.m3u8`
- **Construct `thumbnailUrl` (HLS video thumbnail):**
  `https://video.cdn.bsky.app/hls/{authorDid}/{video_blob_cid}/thumbnail.jpg`
- Save to Firestore under `mediaEmbed.video`.

---

## 8. Stage 2: Relevance Evaluation Flow

If a post passes Stage 1 (or is routed from the Like/Repost resolver), the pipeline executes the following evaluation flow:

```mermaid
graph TD
    Start[Post Passes Stage 1] --> CheckConfig{AI_FILTERING_ENABLED == true?}
    
    CheckConfig -- Yes --> CallLLM[Query Gemini API]
    CallLLM --> CheckScore{isRelevant == true?}
    
    CheckScore -- Yes --> QueueOutbox[Insert into posts_outbox: write]
    CheckScore -- No --> Discard[Discard Post]
    
    CheckConfig -- No --> WriteBypass[Set default score/metadata]
    WriteBypass --> QueueOutbox
```

### 8.1 AI-Bypass Mode (`AI_FILTERING_ENABLED = false`)
- The post bypasses Gemini evaluation.
- The daemon generates the JSON payload containing the parsed `facets` and `mediaEmbed` objects.
- Insert a record into the SQLite table `posts_outbox` with `action = 'write'` and `status = 'pending'`.

### 8.2 AI-Evaluation Mode (`AI_FILTERING_ENABLED = true`)
- **Model:** `gemini-2.5-flash`
- **Parameters:** `temperature: 0.1`, `responseMimeType: "application/json"`
- Enforces the output schema matching `{"isRelevant": boolean, "score": integer, "reasoning": string}`.
- If `isRelevant == true`, generate the payload and insert a row into the SQLite table `posts_outbox` with `action = 'write'` and `status = 'pending'`.
- If `isRelevant == false`, discard the post.

---

## 9. Error Handling & Exception Logging

To isolate errors and debug processing failures without halting ingestion, all core steps inside the daemon must execute within `try-catch` structures.

### 9.1 Failures Capture Logic
If any of the following events fail:
- **WebSocket Parse Failure:** Received data is malformed or cannot be unmarshaled.
- **HTTP Fetch Outage:** Outbound calls to AppView (`getPosts` or follow resolutions) fail or return non-200 codes.
- **AI Classification Fail:** Gemini API yields timeout, quota limit, or parsing failure.
- **Local DB Write Error:** SQLite locks or transaction aborts.
- **Firestore Sync Timeout:** Cloud sync worker fails to write payload.

### 9.2 SQL Insertion
The daemon must catch the error and immediately write to the local `processing_failures` table:
```sql
INSERT INTO processing_failures (event_type, raw_payload, error_message, created_at)
VALUES (
    '{EVENT_TYPE}',          -- e.g., 'gemini_call'
    '{RAW_JSON_PAYLOAD}',    -- Stringified event payload
    '{ERROR_MESSAGE_STRING}',-- Exact exception text
    '{CURRENT_UTC_TIMESTAMP}'
);
```

---

## 10. Firestore Outbox Sync Worker

An asynchronous background task within the daemon runs continuously to push local outbox records to Firebase Firestore.

### 10.1 Sync Execution Loop
1. Fetch all items in SQLite `posts_outbox` where `status = 'pending'` or `status = 'failed'` ordered by `created_at` ASC.
2. For each record:
   - **Case A: `action == 'write'`**
     - Parse the `payload` JSON string.
     - Call the Firestore SDK to write/upsert the document: `db.collection('posts').doc(post_id).set(payload_object)`.
   - **Case B: `action == 'delete'`**
     - Call the Firestore SDK to update the document: `db.collection('posts').doc(post_id).update({ isDeleted: true })`.
   - **On Success:** Delete the row from the local `posts_outbox` table.
   - **On Failure (e.g., connection lost):**
     - Increment the `retry_count` in the SQLite table.
     - Set `status = 'failed'`.
     - Stop execution of the loop, sleep for a backoff duration, and then retry.

### 10.2 Backoff Constraints
- **Delay Algorithm:** Use exponential backoff with jitter:
  `delay = min(5000 * (1.5 ^ retry_count), 300000) + random_jitter_ms` (Starts at 5s, doubles up to a maximum delay of 5 minutes).

---

## 11. Stage 3: Simple Feedback Accumulation

1. **Dashboard UI Action:** User feedback Thumbs Up/Down updates the Firestore record setting `feedback` to `"relevant"`, `"irrelevant"`, etc.
2. **Local Synced Log:** Every 24 hours, the home server daemon queries Firestore for all rated posts and appends them to `./data/feedback_archive.jsonl`.

---

## 12. Assumptions Log

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A005 | Datetime fields must use ISO-8601 UTC strings. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A006 | The Gemini API key will be loaded via a local env file on the Home Server. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
