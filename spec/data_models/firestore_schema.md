# Firestore Schema & Security Rules Specification

This document specifies the Firestore database structure, document schemas, indexing requirements, and security rules for the hybrid AT Protocol Feed Monitor.

---

## 1. Firestore Schema & Collections

We utilize two primary collections and a statistics collection containing a singleton document in Firestore:
* 1.1. `threads`: Represents threads of filtered feed items matching developer keywords or network parameters.
* 1.2. `feedback_logs`: Archives all rating events with metadata to support offline analysis.
* 1.3. `stats`: Contains a single backend status monitoring document.

---

### 1.1 `threads` Collection

* 1.1.1. **Path:** `/threads/{threadId}`
* 1.1.2. **Document ID (`threadId`):** Generate as the `SHA-256` hash of the conversation's root post ATProto URI string.
* 1.1.3. **Document Schema JSON Model:**
```json
{
  "rootUri": "at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c",
  "latestMatchedAt": "2026-07-01T11:45:05.123Z",
  "hasUnreviewed": true,
  "maxUnreviewedScore": 85,
  "threadFeedback": null,
  "isDeleted": false,
  "posts": [
    {
      "uri": "at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c",
      "cid": "bafyreihymx...",
      "authorDid": "did:plc:rpqw572o3uowvjscsps5u7e6",
      "authorHandle": "devguy.bsky.social",
      "text": "Check out this new ATProto AppView implementation in Rust! https://github.com/... #atproto",
      "createdAt": "2026-07-01T11:45:00.000Z",
      "matchedAt": "2026-07-01T11:45:05.123Z",
      "relevanceScore": 85,
      "relevanceExplanation": "Post mentions ATProto AppView implementation in Rust with a link to source code.",
      "matchRules": ["keyword:atproto", "keyword:appview"],
      "feedback": null, 
      "feedbackAt": null,
      "parentContext": {
        "uri": "at://did:plc:anotherdev/app.bsky.feed.post/999",
        "authorHandle": "seniorguy.bsky.social",
        "text": "Has anyone tried building an AppView in Rust yet?"
      },
      "quotedContext": null,
      "facets": [
        {
          "start": 58,
          "end": 79,
          "type": "link",
          "uri": "https://github.com/..."
        },
        {
          "start": 80,
          "end": 89,
          "type": "tag",
          "tag": "atproto"
        }
      ],
      "mediaEmbed": {
        "type": "images",
        "images": [
          {
            "thumbUrl": "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:rpqw572o3uowvjscsps5u7e6/bafyimgcid@jpeg",
            "fullsizeUrl": "https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:rpqw572o3uowvjscsps5u7e6/bafyimgcid@jpeg",
            "alt": "Screenshot of build log"
          }
        ],
        "externalLink": null,
        "video": null
      }
    }
  ],
  "version": "v2.0.0"
}
```

* 1.1.4. **Document Fields Schema:**

| ID | Field Name | Type | Description |
|---|---|---|---|
| 1.1.4.1 | `rootUri` | string | The full AT Protocol URI of the thread's root post. |
| 1.1.4.2 | `latestMatchedAt` | string (ISO-8601 UTC) | The ingestion timestamp of the most recently matched post in this thread. |
| 1.1.4.3 | `hasUnreviewed` | boolean | Set to `true` if the thread contains one or more posts where `feedback == null`. |
| 1.1.4.4 | `maxUnreviewedScore`| number | The highest relevance score among all unreviewed posts in the thread. Returns `0` if all are rated. |
| 1.1.4.5 | `threadFeedback` | string or null | Consolidated rating for the entire thread (representing the maximum rating applied, or `null`). |
| 1.1.4.6 | `isDeleted` | boolean | Set to `true` if the entire thread is deleted. Defaults to `false`. |
| 1.1.4.7 | `posts` | array of objects | Nested array of posts belonging to this thread that passed relevance filtering. |
| 1.1.4.8 | `version` | string | The version tag of the system that processed this thread (e.g. `"v2.0.0"`). |

---

### 1.2 `feedback_logs` Collection

* 1.2.1. **Path:** `/feedback_logs/{feedbackId}`
* 1.2.2. **Document ID (`feedbackId`):** Automatically generated UUID / Firestore ID.
* 1.2.3. **Document Fields Schema:**

| ID | Field Name | Type | Description |
|---|---|---|---|
| 1.2.3.1 | `threadId` | string | The SHA-256 document ID of the associated thread. |
| 1.2.3.2 | `postUri` | string | The full AT Protocol URI of the specific post rated. |
| 1.2.3.3 | `authorDid` | string | The decentralized identifier of the post author. |
| 1.2.3.4 | `feedback` | string | The feedback rating provided (`"negative"`, `"neutral"`, `"positive"`, `"extra_positive"`, `"superseded"`, or `"interacted"`). |
| 1.2.3.5 | `submittedAt` | string (ISO-8601 UTC) | Timestamp of when the user submitted the feedback rating. |
| 1.2.3.6 | `userEmail` | string | Whitelisted email address of the administrator who submitted the feedback. |
| 1.2.3.7 | `version` | string | The version tag of the frontend/system active at the time the feedback was logged. |

---

### 1.3 `stats` Collection (Singleton)

* 1.3.1. **Path:** `/stats/backend`
* 1.3.2. **Document ID:** `backend`
* 1.3.3. **Document Schema JSON Model:**
```json
{
  "lastActive": "2026-07-05T10:55:00.000Z",
  "lastBatchTime": "2026-07-05T10:50:00.000Z",
  "queueSize": 12,
  "geminiFailureCount24h": 0,
  "lastBatchProcessedCount": 45,
  "lastBatchSuccessCount": 45,
  "lastBatchRelevantCount": 3,
  "lastError": null,
  "backendStatus": "online",
  "firehoseCount1h": 1200,
  "firehoseCount24h": 28000,
  "passedStage1Count1h": 150,
  "passedStage1Count24h": 3200,
  "passedStage2Count1h": 10,
  "passedStage2Count24h": 180,
  "lastFirehosePostAt": "2026-07-05T10:54:58.123Z",
  "lastPassedStage1At": "2026-07-05T10:54:30.456Z",
  "lastPassedStage2At": "2026-07-05T10:50:00.000Z",
  "version": "v2.0.0"
}
```
* 1.3.4. **Document Fields Schema:**

| ID | Field Name | Type | Description |
|---|---|---|---|
| 1.3.4.1 | `lastActive` | string (ISO-8601 UTC) | Timestamp of when the daemon was last active (heartbeat). |
| 1.3.4.2 | `lastBatchTime` | string (ISO-8601 UTC) | Timestamp of when the last batch process finished. |
| 1.3.4.3 | `queueSize` | number | Number of posts currently queued for evaluation in SQLite. |
| 1.3.4.4 | `geminiFailureCount24h` | number | Count of Gemini API call failures logged in the last 24 hours. |
| 1.3.4.5 | `lastBatchProcessedCount` | number | Number of posts selected for the last batch evaluation run. |
| 1.3.4.6 | `lastBatchSuccessCount` | number | Number of posts successfully classified (either relevant or irrelevant) in the last batch run. |
| 1.3.4.7 | `lastBatchRelevantCount` | number | Number of posts from the batch that were found relevant and written to the outbox. |
| 1.3.4.8 | `lastError` | string or null | Error details of the last logged processing failure, or null if none. |
| 1.3.4.9 | `backendStatus` | string | Hardcoded status representing backend presence (`"online"`). |
| 1.3.4.10 | `firehoseCount1h` & `firehoseCount24h` | number | Ingested post counts from the Jetstream firehose in the last 1 and 24 hours. |
| 1.3.4.11 | `passedStage1Count1h` & `passedStage1Count24h` | number | Count of posts passing Stage 1 keyword/network filters in the last 1 and 24 hours. |
| 1.3.4.12 | `passedStage2Count1h` & `passedStage2Count24h` | number | Count of posts evaluated as relevant by Gemini in the last 1 and 24 hours. |
| 1.3.4.13 | `lastFirehosePostAt` | string (ISO-8601 UTC) or null | Timestamp of the last post message received from the firehose. |
| 1.3.4.14 | `lastPassedStage1At` | string (ISO-8601 UTC) or null | Timestamp of the last post that successfully passed Stage 1 filtering. |
| 1.3.4.15 | `lastPassedStage2At` | string (ISO-8601 UTC) or null | Timestamp of the last post that successfully passed Gemini Stage 2 evaluation. |
| 1.3.4.16 | `version` | string | The active system version of the backend daemon. |

### 1.4 `deployments` Collection (Deployment Shift Log)

* 1.4.1. **Path:** `/deployments/{deploymentId}`
* 1.4.2. **Document ID (`deploymentId`):** Unique generated string key (e.g. `{version}_{timestamp}`).
* 1.4.3. **Document Schema JSON Model:**
```json
{
  "version": "v2.0.0",
  "deployedAt": "2026-07-05T14:00:00.000Z",
  "environment": "backend",
  "model": "gemini-3.1-flash-lite",
  "batchIntervalSeconds": 300,
  "batchEvalCap": 100,
  "aiFilteringEnabled": true
}
```
* 1.4.4. **Document Fields Schema:**

| ID | Field Name | Type | Description |
|---|---|---|---|
| 1.4.4.1 | `version` | string | The version tag associated with this deployment. |
| 1.4.4.2 | `deployedAt` | string (ISO-8601 UTC) | Timestamp of when the version deployment event was recorded. |
| 1.4.4.3 | `environment` | string | The active system layer shifted (`"backend"` or `"frontend"`). |
| 1.4.4.4 | `model` | string | The active Gemini model name configured for this backend shift. |
| 1.4.4.5 | `batchIntervalSeconds` | number | The batch run interval seconds active during this shift. |
| 1.4.4.6 | `batchEvalCap` | number | The cap on the evaluated post count per batch. |
| 1.4.4.7 | `aiFilteringEnabled` | boolean | Indicates if Gemini AI classification was active. |

---

## 2. Required Indexes

To query the feed efficiently on the client, the following indexes must be provisioned in Firebase:

### 2.1 Single-field Indexes
* 2.1.1. **Collection:** `threads`
  - Field: `latestMatchedAt` (Descending)

### 2.2 Composite Indexes
* 2.2.1. **Collection:** `threads`
  - Fields: `isDeleted` (Ascending), `hasUnreviewed` (Ascending), `maxUnreviewedScore` (Descending), `latestMatchedAt` (Descending)
  - Purpose: Retrieve all threads containing unreviewed posts, sorted by the highest unreviewed score first, then matching time.

---

## 3. Firebase Security Rules (`firestore.rules`)

To secure the database, we restrict read/write access exclusively to your verified Google email address. No public reads or writes are allowed.

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    
    // Helper function to check if the user is signed in and matches the owner email
    function isOwner() {
      return request.auth != null 
        && request.auth.token.email_verified == true
        && request.auth.token.email == "OWNER_EMAIL_PLACEHOLDER";
    }

    // Rule for matching posts
    match /posts/{postId} {
      allow read, write: if isOwner();
    }

    // Rule for logging feedback
    match /feedback_logs/{feedbackId} {
      allow read, write: if isOwner();
    }

    // Rule for backend stats
    match /stats/{docId} {
      allow read, write: if isOwner();
    }

    // Rule for deployments
    match /deployments/{deploymentId} {
      allow read, write: if isOwner();
    }
  }
}
```

* 3.1. **Rules Version & Service:** Declare `rules_version = '2'` and targets `service cloud.firestore`.
* 3.2. **Owner Check Helper (`isOwner()`):**
  - 3.2.1. Assert authentication is not null: `request.auth != null`.
  - 3.2.2. Assert user email is verified: `request.auth.token.email_verified == true`.
  - 3.2.3. Assert user email matches the whitelisted owner email: `request.auth.token.email == "OWNER_EMAIL_PLACEHOLDER"`.
* 3.3. **`posts` Collection Path Access:** Allow read/write access on `/posts/{postId}` if and only if `isOwner()` is true.
* 3.4. **`feedback_logs` Collection Path Access:** Allow read/write access on `/feedback_logs/{feedbackId}` if and only if `isOwner()` is true.
* 3.5. **`stats` Collection Path Access:** Allow read/write access on `/stats/{docId}` if and only if `isOwner()` is true.
* 3.6. **`deployments` Collection Path Access:** Allow read/write access on `/deployments/{deploymentId}` if and only if `isOwner()` is true.

> [!IMPORTANT]
> The developer/agent implementing this deployment must replace `OWNER_EMAIL_PLACEHOLDER` with the owner's actual Google Account email address during the Firebase deploy step.

---

## 4. Assumptions Log

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A005 | Datetime fields must use ISO-8601 UTC strings. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A012 | Backend statistics are loaded dynamically from `/stats/backend` in Firestore. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
