# System Architecture: AT Protocol Hybrid Feed Monitor

This document details the high-level architecture, component communication flows, security boundaries, and data synchronization for the hybrid AT Protocol Developer Feed Monitor.

---

## 1. System Topology

The system splits responsibilities between a secure local home server environment and a publicly accessible Google Firebase cloud environment, using client-side OAuth for direct Bluesky interactions.

```mermaid
graph TB
    subgraph AT Protocol Network
        Jetstream[Jetstream Firehose<br>posts, follows, reposts, likes]
        PDS[User's PDS / Bluesky API<br>https://bsky.social]
        BlueskyApp[Bluesky App/Web client<br>https://bsky.app]
    end
 
    subgraph Home Server (Private Local Network)
        Daemon[Ingestion & Filtering Daemon]
        BatchWorker[5-Min Batch Evaluator<br>Gemini 3.1 Flash-Lite]
        RulesConfig[Local Rules Config<br>keywords, whitelist]
        GraphDB[(Local Database<br>SQLite)]
        OutboxWorker[Outbox Sync Worker]
    end
 
    subgraph Firebase Cloud Environment
        Firestore[(Cloud Firestore Database)]
        Hosting[Firebase Hosting<br>Static Web Dashboard]
        Auth[Firebase Auth<br>Google Sign-In]
    end
 
    subgraph Client Browser
        DashboardApp[Single Page App UI<br>with compact side drawer]
        OAuthSession[ATProto OAuth Tokens<br>LocalStorage]
    end
 
    %% Ingestion Flow
    Jetstream -- JSON Stream posts/follows/reposts/likes --> Daemon
    Daemon -- Read Rule Settings --> RulesConfig
    Daemon -- Query/Sync Graph --> GraphDB
    Daemon -- Queue Matched Posts --> GraphDB
 
    %% Batch Worker Flow
    BatchWorker -- 1. Pull Batch --> GraphDB
    BatchWorker -- 2. Query Gemini --> BatchWorker
    BatchWorker -- 3. Write Outbox --> GraphDB
    BatchWorker -- 4. Publish Stats --> Firestore
 
    %% Outbox Sync
    OutboxWorker -- Read Queue --> GraphDB
    OutboxWorker -- Push to Cloud --> Firestore
 
    %% UI and Firestore Sync
    DashboardApp -- Listen/Query Posts --> Firestore
    DashboardApp -- Listen Backend Stats --> Firestore
    DashboardApp -- Write Thumbs Up/Down Feedback --> Firestore
    DashboardApp -- Authenticate Email --> Auth
 
    %% OAuth & Direct Engagement
    DashboardApp -- 1. Trigger OAuth Flow --> PDS
    PDS -- 2. Redirect with Auth Code --> DashboardApp
    DashboardApp -- 3. Create Like / Follow XRPC --> PDS
 
    %% Reply Link
    DashboardApp -- Open Post for Reply --> BlueskyApp
```

### 1.1 Components

1.1.1. **Ingestion & Filtering Daemon (Home Server):**
* 1.1.1.1. Run as a background service (Go/Rust/Node.js) operating 24/7 on the home server.
* 1.1.1.2. Subscribe to real-time posts (`post`), follows (`follow`), reposts (`repost`), and likes (`like`) from Jetstream.
* 1.1.1.3. Filter posts matching keyword rules or written/interacted with (reposted or liked) by your 1st-degree follows.
* 1.1.1.4. Monitor Jetstream for record deletion events and soft-delete the corresponding Firestore documents.

1.1.2. **Local Database (Home Server):**
* 1.1.2.1. Manage local state using a local SQLite database (`network_graph.db`).
* 1.1.2.2. Maintain a list of 1st-degree follows mapping RKeys to DIDs.
* 1.1.2.3. Queue matched posts in a **`evaluation_queue`** table waiting for batch relevance evaluation.
* 1.1.2.4. Queue evaluated, relevant posts in a **`posts_outbox`** table until they are successfully written to Firestore.

1.1.3. **Outbox Sync Worker (Home Server):**
* 1.1.3.1. Monitor the local `posts_outbox` queue.
* 1.1.3.2. Push entries to Cloud Firestore using an exponential backoff retry mechanism.

1.1.4. **Cloud Firestore (Firebase):**
* 1.1.4.1. Act as the central synchronization database storing matched posts and user feedback logs.

1.1.5. **Firebase Hosting & Web Dashboard (Client Browser):**
* 1.1.5.1. Serve a PWA-enabled Single-Page Application (SPA) hosted on Firebase.
* 1.1.5.2. Provide interfaces for user authentication, feed rendering, custom interaction buttons, and feedback logging.

1.1.6. **Firebase Authentication:**
* 1.1.6.1. Handle Google Login to restrict dashboard access.

---

## 2. Security Boundaries & Authentication

### 2.1 Network Security
* 2.1.1. **No Inbound Port Forwarding:** The home server daemon acts solely as a client. It establishes outbound WebSocket connections to Jetstream and outbound HTTP/WebSocket connections to Cloud Firestore. This completely protects the home network from external scans and attacks.

### 2.2 Dashboard Access Security (Firebase Auth)
* 2.2.1. **Google Sign-In:** Authenticate users via Google Sign-In.
* 2.2.2. **Email Whitelist Verification:** Use Firestore Security Rules to validate that the authenticated user's email (`request.auth.token.email`) matches your designated email address.
* 2.2.3. **Unauthorized Block:** Reject all read/write attempts from unauthenticated or non-whitelisted users.

### 2.3 ATProto OAuth (Client-Side Engagement)
Instead of storing your Bluesky app password on a server, the dashboard uses client-side ATProto OAuth to securely authorize direct actions.
* 2.3.1. **Client Metadata:** The frontend hosts a `client-metadata.json` file on its Firebase Hosting origin declaring its client identity, redirect URIs, and requested scopes.
* 2.3.2. **Authentication Flow:** When you click "Connect Bluesky Account", the web app redirects you to your PDS (e.g., `bsky.social`) where you authorize the client app.
* 2.3.3. **Token Management:** The PDS redirects back to the dashboard with an authorization code. The web app exchanges this for `access_token` and `refresh_token` payloads and stores them locally in browser memory/LocalStorage.
* 2.3.4. **Direct Actions (Likes & Follows):** When you click "Like" or "Follow" in the dashboard, the browser app crafts the XRPC request and sends it directly to your PDS using the stored OAuth access token.
* 2.3.5. **Indirect Actions (Replies):** Since replies are disabled in-app to simplify thread management, the UI provides a button linking to `https://bsky.app/profile/{authorDid}/post/{rkey}` to let you comment natively.

---

## 3. Data Synchronization Boundaries

The following table outlines what data is synchronized between the Home Server, Firestore, and the Browser:

| ID | Data Entity | Primary Source | Writer(s) | Reader(s) | Sync Mechanism |
|---|---|---|---|---|---|
| 3.1 | **Filtered Posts** | Home Server Daemon | Home Server Daemon | Web Dashboard | Daemon writes to local outbox; sync worker pushes to Firestore; Dashboard uses real-time snapshot listener. |
| 3.2 | **Thumbs Up/Down Feedback** | Web Dashboard | Web Dashboard | Home Server Daemon | Dashboard writes to a sub-collection; Daemon reads periodically or via snapshot listener. |
| 3.3 | **OAuth Credentials** | User's PDS | Web Dashboard | User's PDS | Stored in client browser LocalStorage only. Never sent to the Home Server or Firestore. |
| 3.4 | **Filtering Rules & Graph** | Home Server DB/Config | Home Server Daemon / Config File | Home Server Daemon | Stored locally on the Home Server. |
| 3.5 | **Backend Processing Stats** | Home Server Daemon | Home Server Daemon | Web Dashboard | Daemon writes stats to Firestore `/stats/backend` document; Dashboard listens via real-time snapshot listener. |

---

## 4. Assumptions Log

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A001 | Target database in Firebase is Cloud Firestore. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A002 | Access restriction is based on Google Sign-In with email validation. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A003 | Dashboard engagement is a mix of direct client actions (like, follow) via OAuth and redirect links (replies) to bsky.app. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A004 | Feedback training is simple logging for later evaluation. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A007 | Deleted posts are soft-deleted in Firestore (`isDeleted: true`). | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A008 | Client-side search and filtering in the UI is not required for version 1. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A009 | The default cap on the number of posts processed in a single batch is 100. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
| A010 | Backlogged posts exceeding the batch cap are kept in the queue indefinitely to carry over. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
| A011 | Secondary features and statistics panel are placed inside a collapsible side drawer. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
| A012 | Backend statistics are loaded dynamically from `/stats/backend` in Firestore. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
