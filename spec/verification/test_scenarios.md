# Test & Verification Scenarios

This document specifies the target test suite, mock payloads, and assertions required to verify the implementation of the AT Protocol Feed Monitor.

---

## 1. Firebase Security Rules Verification

The following test scenarios must be verified (e.g., using the Firebase Security Rules Local Emulator Suite or production staging tests).

### 1.1 Unauthenticated Read/Write Block
- **Test Setup:** Client SDK initialized without signing in.
- **Test Action 1:** Attempt to read `/posts/test-id`.
  - **Expected Result:** API returns `Permission Denied` (HTTP 403 equivalents).
- **Test Action 2:** Attempt to write to `/posts/test-id` or `/feedback_logs/test-id`.
  - **Expected Result:** API returns `Permission Denied`.

### 1.2 Non-Owner Read/Write Block
- **Test Setup:** Client signed in via Firebase Auth with email `intruder@gmail.com` (not matching the whitelisted owner email).
- **Test Action 1:** Attempt to read `/posts/test-id`.
  - **Expected Result:** API returns `Permission Denied`.
- **Test Action 2:** Attempt to write to `/posts/test-id` or `/feedback_logs/test-id`.
  - **Expected Result:** API returns `Permission Denied`.

### 1.3 Owner Read/Write Access
- **Test Setup:** Client signed in via Firebase Auth with email matching the exact whitelist (e.g., `owner@gmail.com`).
- **Test Action 1:** Attempt to read `/posts`.
  - **Expected Result:** Query succeeds and returns documents.
- **Test Action 2:** Attempt to update a post's `feedback` field.
  - **Expected Result:** Write succeeds.

---

## 2. Ingestion & Filtering Engine Verification

These tests verify the Home Server daemon's parsing logic using mock JSON feeds.

### 2.1 Ingestion Parsing and Regex Matching
- **Mock Input Event:**
  ```json
  {
    "did": "did:plc:rpqw572o3uowvjscsps5u7e6",
    "time_us": 1715623456789012,
    "kind": "commit",
    "commit": {
      "rev": "3ks5z3a2jzk2c",
      "operation": "create",
      "collection": "app.bsky.feed.post",
      "rkey": "3ks5z3a2jzk2c",
      "record": {
        "$type": "app.bsky.feed.post",
        "text": "My new atproto app is live, running my own PDS now!",
        "createdAt": "2026-07-01T11:45:00.000Z"
      }
    }
  }
  ```
- **Assertion:**
  - Daemon parses commit correctly.
  - Text triggers regex matches for `atproto` and `pds`.
  - Post is routed to Stage 2 (Gemini LLM evaluation or direct Firestore write if bypass mode is active).

### 2.2 Off-Topic Discard
- **Mock Input Event:**
  ```json
  {
    "did": "did:plc:rpqw572o3uowvjscsps5u7e6",
    "time_us": 1715623456789012,
    "kind": "commit",
    "commit": {
      "rev": "3ks5z3a2jzk2c",
      "operation": "create",
      "collection": "app.bsky.feed.post",
      "rkey": "3ks5z3a2jzk2c",
      "record": {
        "$type": "app.bsky.feed.post",
        "text": "Had a great coffee this morning! #morning #cafe",
        "createdAt": "2026-07-01T11:45:00.000Z"
      }
    }
  }
  ```
- **Assertion:**
  - Text triggers zero regex rules.
  - Author DID is not in the local Network Graph (1st-degree follows) or curated whitelist.
  - Post is immediately discarded. Gemini is **not** called.

### 2.3 Network Graph Bypass (1st-Degree Follows)
- **Mock Input Event:**
  - Post text: "Had a great coffee this morning! #morning #cafe" (Zero keyword matches)
  - Author DID: `did:plc:deva12345`
  - **Graph State:** `did:plc:deva12345` is present in the `first_degree_follows` database.
- **Assertion:**
  - Daemon detects the author is in your 1st-degree follows.
  - Post bypasses regex keyword checks.
  - Post is routed directly to Gemini LLM for relevance evaluation.

---

## 3. Liked & Reposted Content Resolver Verification

These tests verify resolving post metadata when a followed account interacts with it.

### 3.1 Repost Sync
- **Mock Input Event (Repost):**
  ```json
  {
    "did": "did:plc:deva12345",
    "time_us": 1715623459999000,
    "kind": "commit",
    "commit": {
      "operation": "create",
      "collection": "app.bsky.feed.repost",
      "rkey": "3ksrepostrkey",
      "record": {
        "$type": "app.bsky.feed.repost",
        "subject": {
          "uri": "at://did:plc:creator/app.bsky.feed.post/post123",
          "cid": "bafypostcid"
        },
        "createdAt": "2026-07-01T11:45:00.000Z"
      }
    }
  }
  ```
- **Test Setup:**
  - `did:plc:deva12345` exists in the local `first_degree_follows` table (with handle `deva.bsky.social`).
  - Mock response from `app.bsky.feed.getPosts?uris=at://did:plc:creator/app.bsky.feed.post/post123` returns post details.
- **Assertion:**
  - Daemon validates that the repost actor is a followed account.
  - Daemon successfully triggers HTTP call to resolve target post details.
  - Resolved post payload contains `matchRules = ["repost:deva.bsky.social"]`.
  - Resolved post bypasses keyword checks and is routed directly to Stage 2.

---

## 4. Context & Media Retrieval Verification

These scenarios verify the crawling and parsing of media assets, links, and replies.

### 4.1 Reply Thread Context Crawl
- **Mock Input Event:** Post has `reply` property pointing to parent post `at://did:plc:parent/app.bsky.feed.post/999`.
- **Test Setup:** Mock external response from `app.bsky.feed.getPosts?uris=at://did:plc:parent/app.bsky.feed.post/999` returns parent content.
- **Assertion:**
  - The local `posts_outbox` payload contains the `parentContext` object:
    `{ "uri": "at://did:plc:parent...", "authorHandle": "parentuser.bsky.social", "text": "Parent post content text" }`.

### 4.2 Rich Text Facets Extraction
- **Mock Input Event:** Post contains a link facet (`app.bsky.richtext.facet#link`) at bytes index `58` to `79` pointing to `https://github.com/my/repo`.
- **Assertion:**
  - Outbox payload includes a `facets` entry:
    `{ "start": 58, "end": 79, "type": "link", "uri": "https://github.com/my/repo" }`.

### 4.3 Media Embed CDN URL Resolution
- **Mock Input Event (Images):** Ingest a post from author `did:plc:rpqw572o3uowvjscsps5u7e6` with an image embed containing blob reference CID `bafyimgcid`.
- **Assertion:**
  - Outbox payload contains the `mediaEmbed.images` structure with constructed hotlink URLs.

---

## 5. SQLite Outbox Queue & Error Logging Verification

These tests verify data persistence, reliability of the outbox, and error capturing.

### 5.1 Outbox Insertion on Match
- **Given:** A post passes Gemini evaluation successfully.
- **Assertion:**
  - A row is inserted in the SQLite `posts_outbox` table containing the correct SHA-256 `post_id` as the primary key, `action = 'write'`, the JSON document payload, and `status = 'pending'`.

### 5.2 Outbox Processing under Outage (Offline Mode)
- **Test Setup:** Disconnect the home server's internet access (mock Firestore write timeout/network failure).
- **Test Action:** Route 3 matching posts through the filtering pipeline.
- **Assertion:**
  - The SQLite table `posts_outbox` successfully accumulates all 3 posts with `status = 'failed'` and their `retry_count` increments.

### 5.3 Exception Logging (Processing Failures)
- **Test Setup:** Mock an AppView API timeout error (HTTP 504) during the parent thread resolution callback.
- **Test Action:** Ingest a reply post matching keyword criteria.
- **Assertion:**
  - The daemon catches the HTTP connection timeout exception.
  - The daemon writes a row to the SQLite `processing_failures` table containing:
    - `event_type = 'context_fetch'`
    - `raw_payload = '{MOCK_JETSTREAM_POST_JSON}'`
    - `error_message = 'AppView API request timeout: HTTP 504'`
    - `created_at` = valid ISO-8601 UTC timestamp.
  - Ingestion does not halt; subsequent firehose commits continue to be parsed normally.

---

## 6. Network Graph Sync Verification

### 6.1 New Follow (By Owner)
- **Mock Input Event:** Creating a follow on `app.bsky.graph.follow`.
- **Assertion:**
  - Row `(3ks5z3followrkey, did:plc:newfriend123)` is written to `first_degree_follows`.

### 6.2 Unfollow (By Owner)
- **Mock Input Event:** Deleting a follow on `app.bsky.graph.follow`.
- **Assertion:**
  - Row matching `rkey == 3ks5z3followrkey` is deleted from `first_degree_follows`.

---

## 7. UI, PWA & Viewport Verification

These scenarios verify client-side CSS layouts, state transitions, and PWA metadata.

### 7.1 Rich Text Facet Rendering
- **Given:** A post text `Check code at link` and a facets entry: `{ "start": 14, "end": 18, "type": "link", "uri": "https://github.com" }`.
- **Assertion:**
  - The UI text renderer outputs an HTML anchor tag wrapping "link":
    `<a href="https://github.com" target="_blank" ...>link</a>`.

### 7.2 Stable Viewport Query Verification
- **Test Action:** Load the feed. In the background, write a new post to Firestore using timestamp `matchedAt > pageLoadTime`.
- **Assertion:**
  - The feed container remains stable. The new post is NOT added to the timeline automatically.
  - The sticky banner `[ 🗘 Load 1 new posts ]` appears.

### 7.3 Four-Tier Feedback Button Actions
- **Test Action:** Render a post card, and click each feedback button:
  - Click `--`: verify Firestore document updates `feedback = 'negative'`.
  - Click `-`: verify Firestore document updates `feedback = 'neutral'`.
  - Click `+`: verify Firestore document updates `feedback = 'positive'`.
  - Click `++`: verify Firestore document updates `feedback = 'extra_positive'`.

### 7.4 Mobile Fullscreen Layout
- **Test Setup:** Set browser window viewport to width `375px` (mobile portrait).
- **Assertion:**
  - CSS query maps active stylesheet. Main body sets `overflow: hidden`, height `100dvh`.
  - Only **one** post card is rendered in the viewport (matching `posts[activePostIndex]`).
  - Action bar is fixed at the absolute bottom of the screen (`position: fixed; bottom: 0`).
  - Clicking any feedback button increments `activePostIndex` to `1`, transitioning card `0` out and card `1` in.
  - Action bar does not shift height.

### 7.5 PWA Asset Verification
- **Test Action:** Request `/manifest.json` and `/sw.js` HTTP endpoints.
- **Assertion:**
  - `/manifest.json` returns HTTP 200 with standard JSON manifest content.
  - Page index contains `<meta name="apple-mobile-web-app-capable" content="yes">`.
