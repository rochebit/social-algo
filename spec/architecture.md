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
        DashboardApp[Single Page App UI]
        OAuthSession[ATProto OAuth Tokens<br>LocalStorage]
    end

    %% Ingestion Flow
    Jetstream -- JSON Stream posts/follows/reposts/likes --> Daemon
    Daemon -- Read Rule Settings --> RulesConfig
    Daemon -- Query/Sync Graph --> GraphDB
    Daemon -- Write Matched Posts --> GraphDB

    %% Outbox Sync
    OutboxWorker -- Read Queue --> GraphDB
    OutboxWorker -- Push to Cloud --> Firestore

    %% UI and Firestore Sync
    DashboardApp -- Listen/Query Posts --> Firestore
    DashboardApp -- Write Thumbs Up/Down Feedback --> Firestore
    DashboardApp -- Authenticate Email --> Auth

    %% OAuth & Direct Engagement
    DashboardApp -- 1. Trigger OAuth Flow --> PDS
    PDS -- 2. Redirect with Auth Code --> DashboardApp
    DashboardApp -- 3. Create Like / Follow XRPC --> PDS

    %% Reply Link
    DashboardApp -- Open Post for Reply --> BlueskyApp
```

### Components

1. **Ingestion & Filtering Daemon (Home Server):**
   - A background service (Go/Rust/Node.js) running 24/7 on the home server.
   - Subscribes to real-time posts (`post`), follows (`follow`), reposts (`repost`), and likes (`like`) from Jetstream.
   - Filters posts matching keyword rules or written/interacted with (reposted or liked) by your 1st-degree follows.
   - Monitors Jetstream for record deletion events and soft-deletes the corresponding Firestore documents.
2. **Local Database (Home Server):**
   - A local SQLite database (`network_graph.db`) managed by the daemon.
   - Maintains a list of your 1st-degree follows (people you follow) mapping RKeys to DIDs.
   - Contains a **`posts_outbox`** queue table to temporarily buffer matched posts until they are successfully written to Firestore.
3. **Outbox Sync Worker (Home Server):**
   - Monitors the local `posts_outbox` and pushes entries to Firestore using exponential backoff retry.
4. **Cloud Firestore (Firebase):**
   - The central synchronization database storing matched posts and user feedback logs.
5. **Firebase Hosting & Web Dashboard (Client Browser):**
   - A PWA-enabled Single-Page Application (SPA) hosted on Firebase allowing user login, feed display, likes, and follows.
6. **Firebase Authentication:**
   - Handles Google login to restrict dashboard access to the whitelisted owner.

---

## 2. Security Boundaries & Authentication

### Network Security
- **No Inbound Port Forwarding:** The home server daemon acts solely as a client. It establishes outbound WebSocket connections to Jetstream and outbound HTTP/WebSocket connections to Cloud Firestore. This completely protects the home network from external scans and attacks.

### Dashboard Access Security (Firebase Auth)
- To restrict dashboard access to you alone:
  - **Firebase Authentication:** Configured with Google Sign-In.
  - **Firestore Security Rules:** Hardcoded constraint validating that the authenticated user's email (`request.auth.token.email`) matches your designated email address.
  - All unauthorized sign-ins are blocked from reading or writing any documents.

### ATProto OAuth (Client-Side Engagement)
Instead of storing your Bluesky app password on a server, the dashboard uses client-side ATProto OAuth to securely authorize direct actions.
1. **Client Metadata:** The frontend hosts a `client-metadata.json` file on its Firebase Hosting origin declaring its client identity, redirect URIs, and requested scopes.
2. **Authentication Flow:** When you click "Connect Bluesky Account", the web app redirects you to your PDS (e.g., `bsky.social`) where you authorize the client app.
3. **Token Management:** The PDS redirects back to the dashboard with an authorization code. The web app exchanges this for `access_token` and `refresh_token` payloads and stores them locally in browser memory/LocalStorage.
4. **Direct Actions (Likes & Follows):** When you click "Like" or "Follow" in the dashboard, the browser app crafts the XRPC request and sends it directly to your PDS using the stored OAuth access token.
5. **Indirect Actions (Replies):** Since replies are disabled in-app to simplify thread management, the UI provides a button linking to `https://bsky.app/profile/{authorDid}/post/{rkey}` to let you comment natively.

---

## 3. Data Synchronization Boundaries

The following table outlines what data is synchronized between the Home Server, Firestore, and the Browser:

| Data Entity | Primary Source | Writer(s) | Reader(s) | Sync Mechanism |
|---|---|---|---|---|
| **Filtered Posts** | Home Server Daemon | Home Server Daemon | Web Dashboard | Daemon writes to local outbox; sync worker pushes to Firestore; Dashboard uses real-time snapshot listener. |
| **Thumbs Up/Down Feedback** | Web Dashboard | Web Dashboard | Home Server Daemon | Dashboard writes to a sub-collection; Daemon reads periodically or via snapshot listener. |
| **OAuth Credentials** | User's PDS | Web Dashboard | User's PDS | Stored in client browser LocalStorage only. Never sent to the Home Server or Firestore. |
| **Filtering Rules & Graph** | Home Server DB/Config | Home Server Daemon / Config File | Home Server Daemon | Stored locally on the Home Server. |

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
