# Test & Verification Scenarios

This document specifies the target test suite, mock payloads, and assertions required to verify the implementation of the AT Protocol Feed Monitor.

---

## 1. Firebase Security Rules Verification

The following test scenarios must be verified (e.g., using the Firebase Security Rules Local Emulator Suite or production staging tests).

### 1.1 Unauthenticated Read/Write Block
* 1.1.1. **Test Setup:** Initialize the Firebase client SDK without signing in.
* 1.1.2. **Test Action 1:** Attempt to perform a read operation on `/threads/test-id`.
  - 1.1.2.1. **Expected Result:** The API returns `Permission Denied` (HTTP 403 equivalents).
* 1.1.3. **Test Action 2:** Attempt to perform a write or update operation to `/threads/test-id` or `/feedback_logs/test-id`.
  - 1.1.3.1. **Expected Result:** The API returns `Permission Denied` (HTTP 403 equivalents).

### 1.2 Non-Owner Read/Write Block
* 1.2.1. **Test Setup:** Sign in via Firebase Auth with email `intruder@gmail.com` (not matching the whitelisted owner email).
* 1.2.2. **Test Action 1:** Attempt to perform a read operation on `/threads/test-id`.
  - 1.2.2.1. **Expected Result:** The API returns `Permission Denied`.
* 1.2.3. **Test Action 2:** Attempt to perform a write or update operation to `/threads/test-id` or `/feedback_logs/test-id`.
  - 1.2.3.1. **Expected Result:** The API returns `Permission Denied`.

### 1.3 Owner Read/Write Access
* 1.3.1. **Test Setup:** Sign in via Firebase Auth with email matching the exact whitelist (e.g., `owner@gmail.com`).
* 1.3.2. **Test Action 1:** Attempt to perform a read query on `/threads`.
  - 1.3.2.1. **Expected Result:** The query succeeds and returns documents.
* 1.3.3. **Test Action 2:** Attempt to update a thread's `threadFeedback` field.
  - 1.3.3.1. **Expected Result:** The write operation succeeds.

---

## 2. Ingestion & Filtering Engine Verification

These tests verify the Home Server daemon's parsing logic using mock JSON feeds.

### 2.1 Ingestion Parsing and Regex Matching
* 2.1.1. **Mock Input Event:**
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
* 2.1.2. **Assertions:**
  - 2.1.2.1. The daemon parses the commit metadata correctly.
  - 2.1.2.2. Text triggers regex matches for `atproto` and `pds`.
  - 2.1.2.3. If AI filtering is enabled, the parsed post (including text, authors, metadata, and matched rules) is inserted into the local SQLite `evaluation_queue` table with `retry_count = 0` and status pending evaluation.

### 2.2 Off-Topic Discard
* 2.2.1. **Mock Input Event:**
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
* 2.2.2. **Assertions:**
  - 2.2.2.1. The post text triggers zero regex rules.
  - 2.2.2.2. The author DID is verified not to be in the local Network Graph (1st-degree follows) or curated whitelist.
  - 2.2.2.3. The post is immediately discarded, and the Gemini API is **not** called.

### 2.3 Network Graph Bypass (1st-Degree Follows)
* 2.3.1. **Test Setup:**
  - 2.3.1.1. Post text: "Had a great coffee this morning! #morning #cafe" (Zero keyword matches).
  - 2.3.1.2. Author DID: `did:plc:deva12345`.
  - 2.3.1.3. Graph State: `did:plc:deva12345` is populated in the local `first_degree_follows` database.
* 2.3.2. **Assertions:**
  - 2.3.2.1. The daemon detects the author is in your 1st-degree follows.
  - 2.3.2.2. The post bypasses regex keyword checks.
  - 2.3.2.3. The post is inserted into the local SQLite `evaluation_queue` table for batch evaluation.

### 2.4 Non-English Post Discard
* 2.4.1. **Test Setup:**
  - 2.4.1.1. Post text: "My new atproto app is live!" (Matches keyword criteria).
  - 2.4.1.2. Language field: `record.langs = ["ja"]` (Japanese).
* 2.4.2. **Assertions:**
  - 2.4.2.1. The daemon detects that the post language array is set and does not contain `"en"`.
  - 2.4.2.2. The post is immediately discarded, and the Gemini API is **not** called.

### 2.5 Batch Processing, Capping, and Backlog Ordering
* 2.5.1. **Test Setup:**
  - 2.5.1.1. Populate `evaluation_queue` with 150 mock posts ingested at different times (`matched_at` increasing from oldest post 1 to newest post 150).
  - 2.5.1.2. Set `BATCH_EVAL_CAP = 100` and `BATCH_INTERVAL_SECONDS = 300`.
* 2.5.2. **Test Action:** Trigger a batch evaluation worker run.
* 2.5.3. **Assertions:**
  - 2.5.3.1. The worker pulls exactly 100 posts from `evaluation_queue`.
  - 2.5.3.2. The selected posts represent the 100 newest records (posts 51 to 150), verifying correct backlog ordering (most recent posts prioritized first).
  - 2.5.3.3. The 50 older posts (posts 1 to 50) remain in `evaluation_queue` and are not deleted or processed in this batch run.
  - 2.5.3.4. The processed 100 posts are deleted from `evaluation_queue` after their classifications are routed.

### 2.6 Retry Failure Eviction
* 2.6.1. **Test Setup:** A post in `evaluation_queue` has `retry_count = 3`.
* 2.6.2. **Test Action:** Trigger a batch run where the Gemini API call fails with a temporary network timeout.
* 2.6.3. **Assertions:**
  - 2.6.3.1. The worker catches the Gemini API exception, increments `retry_count` to `4`.
  - 2.6.3.2. Because `retry_count > 3`, the post is deleted from `evaluation_queue`.
  - 2.6.3.3. An error entry is written to `processing_failures` with `event_type = 'gemini_call'`.

### 2.7 Backend Stats Publishing
* 2.7.1. **Test Action:** Observe Firestore and local DB state during and after the batch processing of 100 posts (assume 80 irrelevant, 20 relevant).
* 2.7.2. **Assertions:**
  - 2.7.2.1. The `/stats/backend` document in Firestore is updated.
  - 2.7.2.2. The document fields match: `queueSize` matches remaining rows in `evaluation_queue` (e.g. 50), `lastBatchProcessedCount == 100`, `lastBatchSuccessCount == 100`, `lastBatchRelevantCount == 20`, and `backendStatus == "online"`.
  - 2.7.2.3. The heartbeat updates: `lastActive` is set to the current UTC timestamp.

---

## 3. Liked & Reposted Content Resolver Verification

These tests verify resolving post metadata when a followed account interacts with it.

### 3.1 Repost Sync
* 3.1.1. **Mock Input Event (Repost):**
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
* 3.1.2. **Test Setup:**
  - 3.1.2.1. `did:plc:deva12345` exists in the local `first_degree_follows` table (with handle `deva.bsky.social`).
  - 3.1.2.2. Mock response from `app.bsky.feed.getPosts?uris=at://did:plc:creator/app.bsky.feed.post/post123` returns post details.
* 3.1.3. **Assertions:**
  - 3.1.3.1. The daemon validates that the repost actor is a followed account.
  - 3.1.3.2. The daemon successfully triggers HTTP call to resolve target post details.
  - 3.1.3.3. The resolved post payload contains `matchRules = ["repost:deva.bsky.social"]`.
  - 3.1.3.4. The resolved post bypasses keyword checks and is inserted into the local SQLite `evaluation_queue` table.

---

## 4. Context & Media Retrieval Verification

These scenarios verify the crawling and parsing of media assets, links, and replies.

### 4.1 Reply Thread Context Crawl
* 4.1.1. **Mock Input Event:** Post has `reply` property pointing to parent post `at://did:plc:parent/app.bsky.feed.post/999`.
* 4.1.2. **Test Setup:** Mock external response from `app.bsky.feed.getPosts?uris=at://did:plc:parent/app.bsky.feed.post/999` returns parent content.
* 4.1.3. **Assertion:** The local `posts_outbox` payload contains the `parentContext` object:
  `{ "uri": "at://did:plc:parent...", "authorHandle": "parentuser.bsky.social", "text": "Parent post content text" }`.

### 4.2 Rich Text Facets Extraction
* 4.2.1. **Mock Input Event:** Post contains a link facet (`app.bsky.richtext.facet#link`) at bytes index `58` to `79` pointing to `https://github.com/my/repo`.
* 4.2.2. **Assertion:** The outbox payload includes a `facets` entry:
  `{ "start": 58, "end": 79, "type": "link", "uri": "https://github.com/my/repo" }`.

### 4.3 Media Embed CDN URL Resolution
* 4.3.1. **Mock Input Event (Images):** Ingest a post from author `did:plc:rpqw572o3uowvjscsps5u7e6` with an image embed containing blob reference CID `bafyimgcid`.
* 4.3.2. **Assertions:**
  - 4.3.2.1. Outbox payload contains the `mediaEmbed.images` structure.
  - 4.3.2.2. The `thumbUrl` matches: `https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:rpqw572o3uowvjscsps5u7e6/bafyimgcid@jpeg`.
  - 4.3.2.3. The `fullsizeUrl` matches: `https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:rpqw572o3uowvjscsps5u7e6/bafyimgcid@jpeg`.

---

## 5. SQLite Outbox Queue & Error Logging Verification

These tests verify data persistence, reliability of the outbox, and error capturing.

### 5.1 Outbox Insertion on Match
* 5.1.1. **Given:** A post passes Gemini evaluation successfully.
* 5.1.2. **Assertion:** A row is inserted in the SQLite `posts_outbox` table containing the correct SHA-256 `post_id` as the primary key, `action = 'write'`, the JSON document payload, and `status = 'pending'`.

### 5.2 Outbox Processing under Outage (Offline Mode)
* 5.2.1. **Test Setup:** Disconnect the home server's internet access (mock Firestore write timeout/network failure).
* 5.2.2. **Test Action:** Route 3 matching posts through the filtering pipeline.
* 5.2.3. **Assertion:** The SQLite table `posts_outbox` successfully accumulates all 3 posts with `status = 'failed'` and their `retry_count` increments.

### 5.3 Exception Logging (Processing Failures)
* 5.3.1. **Test Setup:** Mock an AppView API timeout error (HTTP 504) during the parent thread resolution callback.
* 5.3.2. **Test Action:** Ingest a reply post matching keyword criteria.
* 5.3.3. **Assertions:**
  - 5.3.3.1. The daemon catches the HTTP connection timeout exception.
  - 5.3.3.2. The daemon writes a row to the SQLite `processing_failures` table containing `event_type = 'context_fetch'` and `error_message = 'AppView API request timeout: HTTP 504'`.

---

## 6. Network Graph Sync Verification

### 6.1 New Follow (By Owner)
* 6.1.1. **Mock Input Event:** Creating a follow on `app.bsky.graph.follow`.
* 6.1.2. **Assertion:** Row `(3ks5z3followrkey, did:plc:newfriend123)` is written to the SQLite `first_degree_follows` table.

### 6.2 Unfollow (By Owner)
* 6.2.1. **Mock Input Event:** Deleting a follow on `app.bsky.graph.follow`.
* 6.2.2. **Assertion:** Row matching `rkey == 3ks5z3followrkey` is deleted from the `first_degree_follows` table.

---

## 7. UI, PWA & Viewport Verification

These scenarios verify client-side CSS layouts, state transitions, PWA metadata, sorting consistency, counters, and thread expansion.

### 7.1 Rich Text Facet Rendering
* 7.1.1. **Given:** A post text `Check code at link` and a facets entry: `{ "start": 14, "end": 18, "type": "link", "uri": "https://github.com" }`.
* 7.1.2. **Assertion:** The UI text renderer outputs an HTML anchor tag wrapping "link":
  `<a href="https://github.com" target="_blank" ...>link</a>`.

### 7.2 Stable Viewport & Score Sorting Verification
* 7.2.1. **Test Action:** Inspect the Firestore query executed by the feed component.
* 7.2.2. **Assertions:**
  - 7.2.2.1. The query strictly specifies order rules: `.orderBy('maxUnreviewedScore', 'desc').orderBy('latestMatchedAt', 'desc')`.
  - 7.2.2.2. Refreshing the feed fetches threads in this identical relevance-first order.
  - 7.2.2.3. The timeline stays static; background-added thread updates trigger the floating sticky banner `[ 🗘 Load 1 new threads ]` instead of inserting themselves.

### 7.3 Real-Time Review Counter
* 7.3.1. **Test Action:** Open the collapsible side drawer and monitor the unreviewed counter adjacent to the Feed link.
  - 7.3.1.1. Increment check: Trigger ingestion daemon write of a new unreviewed thread to Firestore.
  - 7.3.1.2. Decrement check: Click the `+` rating button on a thread card footer.
* 7.3.2. **Assertions:**
  - 7.3.2.1. When the new thread is written, the unreviewed badge count inside the side drawer immediately increments by 1.
  - 7.3.2.2. When the thread card is rated, the unreviewed badge count inside the side drawer immediately decrements by 1.

### 7.4 Full parent Thread conversation
* 7.4.1. **Test Setup:** Load a reply post within a thread card.
  - 7.4.1.1. Mock response from `app.bsky.feed.getPostThread?uri={post.uri}` returning nested ancestor posts.
* 7.4.2. **Assertions:**
  - 7.4.2.1. UI triggers AppView fetch for missing parent context threads.
  - 7.4.2.2. UI renders all ancestor posts in vertical order above the child post.
  - 7.4.2.3. All text content within each ancestor post is fully rendered (zero line clamping, zero string truncation).
  - 7.4.2.4. Vertical connection lines align between user avatars.
  - 7.4.2.5. Ancestor media resolves and is displayed inline below its body text, scaled down by 20%.

### 7.5 Mobile Fullscreen Layout
* 7.5.1. **Test Setup:** Set browser window viewport sizes to simulate a Pixel 10 Pro XL (width `412px`, height `915px`), with mock system notch safe area variables (`env(safe-area-inset-top)` set to `44px` and `env(safe-area-inset-bottom)` set to `34px`).
* 7.5.2. **Assertions:**
  - 7.5.2.1. Global `html` and `body` margin and padding are set to `0`, and overflow is set to `hidden`.
  - 7.5.2.2. Global elements apply `box-sizing: border-box`. The root wrapper container uses `display: flex; flex-direction: column; width: 100vw; height: 100dvh; overflow: hidden;`.
  - 7.5.2.3. The root wrapper padding-top is `env(safe-area-inset-top)`.
  - 7.5.2.4. The active card's viewport height matches the computation: `calc(100dvh - 48px - 72px - env(safe-area-inset-top) - env(safe-area-inset-bottom))` (reflecting minimized 48px header).
  - 7.5.2.5. The active card scroll container enables internal scrolling (`overflow-y: auto`) and defines a bottom buffer (`padding-bottom: 80px`).
  - 7.5.2.6. The bottom action bar clears the swipe indicators: `height: calc(72px + env(safe-area-inset-bottom))` with a padding bottom of `env(safe-area-inset-bottom)`.
  - 7.5.2.7. Only **one** thread card is rendered in the viewport (matching `threads[activePostIndex]`).
  - 7.5.2.8. Clicking any action button increments `activePostIndex` to `1`, transitioning card `0` out and card `1` in.
  - 7.5.2.9. Action bar does not shift height or overlap content area.

### 7.6 PWA Asset Verification
* 7.6.1. **Test Action:** Request `/manifest.json` and `/sw.js` HTTP endpoints.
* 7.6.2. **Assertions:**
  - 7.6.2.1. `/manifest.json` returns HTTP 200 with standard JSON manifest content.
  - 7.6.2.2. Page index contains `<meta name="apple-mobile-web-app-capable" content="yes">`.

### 7.7 Skip Button Viewport Actions
* 7.7.1. **Mobile Skip Verification:** Click the "Skip" button in the bottom action bar on mobile.
  - 7.7.1.1. **Assertion:** The view transitions to card `1` by incrementing `activePostIndex = 1`.
  - 7.7.1.2. **Assertion:** Assert that no update request is sent to Firestore and the `posts` array feedback remains unmodified.
* 7.7.2. **Desktop Skip Verification:** Click the "Skip" button on a thread card in desktop view.
  - 7.7.2.1. **Assertion:** The card is removed from the DOM.
  - 7.7.2.2. **Assertion:** Assert that no update request is sent to Firestore and the `posts` array feedback remains unmodified.

### 7.8 PWA Logo Click Hard Reload
* 7.8.1. **Test Action:** Open the collapsible side drawer, and click the application logo element in the drawer header (or click "Check for Updates" inside the drawer).
* 7.8.2. **Assertions:**
  - 7.8.2.1. The Service Worker registration update check (`registration.update()`) is invoked.
  - 7.8.2.2. A cache-busting page refresh is triggered.

### 7.9 Collapsible Side Drawer & Status Indicator Dot
* 7.9.1. **Test Action 1 (Drawer Open/Close):** Click the hamburger icon (`#menu-toggle-btn`) in the header, then click the backdrop (`#drawer-backdrop`).
  - 7.9.1.1. **Assertion:** Clicking the hamburger toggles the side drawer (`#side-drawer`) state to open (drawer transforms horizontally to `left: 0`).
  - 7.9.1.2. **Assertion:** Clicking the backdrop closes the drawer (transforms back to `left: -280px`).
* 7.9.2. **Test Action 2 (Drawer Content):** Open the side drawer and inspect contents.
  - 7.9.2.1. **Assertion:** Drawer contains Google account user profile, ATProto connect button, navigations with counters, and the Backend Stats panel.
  - 7.9.2.2. **Assertion:** Stats card renders `queueSize`, `geminiFailureCount24h`, relative time since `lastBatchTime`, and `lastError` alert text if present.
* 7.9.3. **Test Action 3 (Status Dot Color Code):** Mock `/stats/backend` values in Firestore.
  - 7.9.3.1. Case A: Set `lastActive = Date.now()`, `geminiFailureCount24h = 0`, `lastError = null`.
    - **Assertion:** The header status dot (`#backend-status-dot`) has green styling.
  - 7.9.3.2. Case B: Set `lastActive = Date.now()`, `geminiFailureCount24h = 2`.
    - **Assertion:** The header status dot has amber styling.
  - 7.9.3.3. Case C: Set `lastActive = Date.now() - 600000` (10 minutes ago).
    - **Assertion:** The header status dot has red styling.
* 7.9.4. **Test Action 4 (Details Modal Toggle & Content):** Click the `#backend-status-dot` in the header, then click the modal backdrop (`#modal-backdrop`).
  - 7.9.4.1. **Assertion:** Clicking the dot opens the Backend Status Details Modal (`#backend-status-modal`) centered in the viewport.
  - 7.9.4.2. **Assertion:** The modal correctly displays the parsed metadata from `/stats/backend` (heartbeat, queue size, failures count, batch stats, and recent error text).
  - 7.9.4.3. **Assertion:** Clicking the backdrop closes the modal, removing `#backend-status-modal` from the active viewport view.

### 7.10 Throughput Metrics & Database Pruning Verification
* 7.10.1. **Metrics Aggregation Test:** Mock 100 entries in the SQLite `metrics_log` table with timestamps spread across the last 30 hours:
  - 7.10.1.1. Case A: 50 events logged in the last 45 minutes.
  - 7.10.1.2. Case B: 30 events logged 5 hours ago.
  - 7.10.1.3. Case C: 20 events logged 26 hours ago.
* 7.10.2. **Assertions:**
  - 7.10.2.1. Verify that the batch worker aggregates exactly 50 events for the 1-hour metrics window.
  - 7.10.2.2. Verify that the batch worker aggregates exactly 80 events for the 24-hour metrics window.
  - 7.10.2.3. Verify that the pruning query runs and successfully deletes the 20 events older than 24 hours (Case C) from the SQLite database.
  - 7.10.2.4. Verify that `/stats/backend` in Firestore is updated with the correct 1-hour and 24-hour throughput values.### 7.11 User Engagement Signal Deduplication & False Negative Capture
* 7.11.1. **Test Action 1 (User Action Capture):** Inject a Jetstream write event for `app.bsky.feed.like` created by `USER_DID` targeting a post URI not yet present in Firestore.
  - 7.11.1.1. **Assertion:** Verify that the daemon resolves the post via AppView XRPC.
  - 7.11.1.2. **Assertion:** Verify that a thread document is created or updated in Firestore containing this post inside its `posts` array, with its feedback set to `"interacted"` and `version` matching the current backend version.
  - 7.11.1.3. **Assertion:** Verify that this thread is not presented as an unreviewed card if it does not contain other unreviewed posts.
* 7.11.2. **Test Action 2 (Existing Post Engagement):** Inject a Jetstream user engagement event targeting an existing Firestore post within a thread document that has a `null` feedback rating.
  - 7.11.2.1. **Assertion:** Verify that the specific post's feedback rating inside the thread's `posts` array is updated to `"interacted"`.
  - 7.11.2.2. **Assertion:** Verify that if this was the last unreviewed post in the thread, the thread's `hasUnreviewed` flag is immediately set to `false`, hiding the thread card from the feed timeline.

### 7.12 Version & Deployment Shift Verification
* 7.12.1. **Test Action 1 (Backend Version Tag):** Query the `/threads` collection in Firestore.
  - 7.12.1.1. **Assertion:** Assert that every thread written contains a `version` attribute matching the active environment config version (e.g. `"v2.0.0"`).
* 7.12.2. **Test Action 2 (Feedback Log Version Tag):** Submit a feedback rating in the frontend app.
  - 7.12.2.1. **Assertion:** Assert that the generated `feedback_logs` entry contains a `version` attribute matching the frontend build version.
* 7.12.3. **Test Action 3 (Startup Deployment Log):** Change the `SYSTEM_VERSION` env key on the backend to `"v2.0.0"` and restart the daemon.
  - 7.12.3.1. **Assertion:** Verify that a new document is written to the Firestore `/deployments` collection containing `"version": "v2.0.0"` and the active parameter configurations.

---

### 7.13 Firestore 24-Hour Document Pruning Verification
* 7.13.1. **Test Setup:** Populate Cloud Firestore with 3 mock thread documents:
  - Thread A: `latestMatchedAt` set to 12 hours ago (within 24-hour window).
  - Thread B: `latestMatchedAt` set to 25 hours ago (outside 24-hour window).
  - Thread C: `latestMatchedAt` set to 30 hours ago (outside 24-hour window).
* 7.13.2. **Test Action:** Trigger the background pruning task in the daemon.
* 7.13.3. **Assertions:**
  - 7.13.3.1. Thread A remains in Firestore.
  - 7.13.3.2. Thread B and Thread C are successfully deleted from Cloud Firestore.
  - 7.13.3.3. Historical records in `feedback_logs` are NOT deleted or modified.

------

## 8. Implementing Agent Verification & Testing Guidelines

These rules apply strictly to any AI agent or developer implementing modifications to the frontend code.

### 8.1 Visual Rendering Inspection
* 8.1.1. **Visual Testing Requirement:** When updating the frontend codebase, the implementing agent must run the application locally, open the UI (either using a headless browser subagent, screenshot verification tool, or manual browser window), and inspect the visual rendering of the interface.
* 8.1.2. **Proactive Improvement Constraint:** The agent must actively search for rendering issues (e.g., misaligned icons, broken layouts, overlapping text, incorrect line-heights, or text truncation) and immediately write fixes to ensure a polished, high-fidelity presentation.

### 8.2 Testing & Authentication Bypass
* 8.2.1. **Test Sign-In Bypass:** The agent must design or leverage a mock sign-in or guest bypass mechanism in the local/emulator environment to access the dashboard views without requiring the actual owner's private Google credentials.
* 8.2.2. **No Faked Feedback Action:** The implementing agent is **strictly prohibited** from writing ratings or submitting post feedback (Thumbs Up/Down) to Firestore on behalf of the owner. All automated/manual verification clicks on feedback buttons must target mock local databases or local emulators only.
