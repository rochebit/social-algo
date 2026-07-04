# Dashboard UI & Layout Specification

This document details the page layout, PWA specifications, component definitions, queries, media rendering, stable viewport interactions, and real-time counters for the Firebase-hosted Web Dashboard.

---

## 1. Application Routing & Views

The dashboard is structured as a single-page application (SPA) containing three primary routes.

```text
/
├── /login            # Unauthenticated landing page (Google OAuth button)
├── /feed             # Default view (unrated custom feed, stable reading order)
└── /archive          # Review view (history of rated posts, search/reset options)
```

---

## 2. Authentication & Access Control

### 2.1 Firebase Auth Client Flow (Dashboard Access)
- Upon opening the app, check `firebase.auth().onAuthStateChanged()`.
- If the user is unauthenticated, redirect to `/login`.
- If the user is authenticated, check their Google email address against the whitelisted address configured during build time:
  - If it matches: redirect to `/feed`.
  - If it does not match: sign the user out immediately and display a clean "Access Denied" message.

### 2.2 ATProto OAuth Session (Bluesky Access)
To interact with the Bluesky API for Liking and Following, the app maintains a client-side OAuth session.
- **Connect Trigger:** A "Connect Bluesky Account" button is rendered in the dashboard header if no active ATProto session token exists in LocalStorage.
- **Metadata Configuration:** The dashboard must serve a valid OAuth client metadata document at `{ORIGIN}/client-metadata.json`.

---

## 3. Stable Viewport Feed Query & Counters

To prevent posts from shifting or moving while reading, the feed does **not** bind a real-time listener directly to the view. Instead, it uses a manual-refresh pagination model.

### 3.1 Consistent Score-Sorted Feed Query
To ensure that refreshing the page displays the same posts in the same order as feed progression (showing the most relevant items first):
1. **Initialize State:** When `/feed` mounts, record `pageLoadTime = new Date().toISOString()`.
2. **Execute Static Fetch:** Query Firestore once (`.get()`):
   - **Collection:** `posts`
   - **Filters:**
     - `isDeleted == false`
     - `feedback == null`
     - `matchedAt <= pageLoadTime`
   - **Sorting:**
     - First Sort: **`relevanceScore` (Descending)** (shows best posts first)
     - Second Sort: **`matchedAt` (Descending)** (fallback chronological order)
   - **Limit:** 50 documents.
3. Render this static array. The items remain completely stationary.

### 3.2 Dynamic Backlog Tracking (Floating Refresh Banner)
1. Simultaneously, query only the **count** of newer posts: `isDeleted == false`, `feedback == null`, `matchedAt > pageLoadTime`.
2. If the snapshot returns a count `N > 0`, display a floating, sticky banner at the top center of the viewport: `[ 🗘 Load {N} new posts ]`.
3. **Click Action:** Update `pageLoadTime`, re-run static query, replace feed state, and scroll back to top.

### 3.3 Real-Time Review Counter
To keep track of how many posts are left to review:
1. **Query Definition:** The UI establishes a real-time listener snapshot checking the total count of unreviewed items:
   ```javascript
   db.collection('posts')
     .where('isDeleted', '==', false)
     .where('feedback', '==', null)
     .onSnapshot(snapshot => {
       const totalUnreviewed = snapshot.size;
       updateUnreviewedCounterUI(totalUnreviewed);
     });
   ```
2. **Visual Placement:** Display the count prominently in the top header: `[ {N} posts remaining to review ]` (e.g. bold slate text, badge icon).
3. **Dynamic Updates:**
   - When the user rates a post (setting `feedback`), the count immediately decrements by 1.
   - When the ingestion daemon pushes new matches to Firestore, the count immediately increments.

---

## 4. Layout & Viewport Variations (Mobile vs. Desktop)

The dashboard presents different layouts depending on the user's screen width.

### 4.1 Mobile Single-Post View (`@media (max-width: 639px)`)
To optimize parsing speed on a phone, the mobile UI presents posts one-at-a-time in full screen.
- **Fullscreen Container:** The main viewport is locked to `width: 100vw` and height `100dvh` (dynamic viewport height). Scrolling on the main body is disabled (`overflow: hidden`).
- **Active Post State:** The React/SPA client maintains an integer state `activePostIndex = 0`.
- **Card Rendering:** The UI renders **only** the single post card matching `posts[activePostIndex]`. This card is centered on screen, takes up 100% of available height (with internal scrolling enabled for very long posts), and has a bottom padding of `80px` to clear the action bar.
- **Fixed Bottom Action Bar:** A sticky container anchored at the bottom of the screen:
  - **CSS:** `position: fixed; bottom: 0; left: 0; right: 0; height: 72px; z-index: 1000; background-color: #1e293b; border-top: 1px solid #334155; display: flex; justify-content: space-around; align-items: center;`
  - **Button Stability:** The buttons remain in the exact same location on the screen at all times, regardless of post length or scrolling.
- **Transition Action:** When a feedback button is clicked:
  - Trigger Firestore document update.
  - Increment `activePostIndex = activePostIndex + 1`.
  - Trigger a CSS card-swipe slide transition.

### 4.2 Desktop Multi-Post View (`@media (min-width: 640px)`)
- Renders as a standard vertical timeline feed showing multiple posts in a single page view.
- Max-width of the feed container is `640px` centered on screen.
- Each post card embeds its own individual action bar.

---

## 5. Extended Feedback Action Buttons

Instead of a simple binary rating, the UI displays four small, iconized/symbolic feedback buttons:

```text
+---------------------------------------------+
|  [ -- ]     [ - ]     [ + ]     [ ++ ]      |
|  Negative  Neutral  Positive  Extra Pos.    |
+---------------------------------------------+
```

### 5.1 Button Mappings & Firestore Values
Clicking a button sets the corresponding string in the post's `feedback` field in Firestore:
- **`--` / Double Minus Icon (Negative):** Saves `feedback = "negative"`. (Noise/Spam)
- **`-` / Single Minus Icon (Neutral):** Saves `feedback = "neutral"`. (Uninterested)
- **`+` / Single Plus Icon (Positive):** Saves `feedback = "positive"`. (High-signal dev)
- **`++` / Double Plus Icon (Extra Positive):** Saves `feedback = "extra_positive"`. (Critical updates/launches)

---

## 6. UI Component Specifications (Post Card)

Every post card renders:

### 6.1 Card Elements & Context Previews
1. **Header:** Author handle and relevance score badge.
2. **Full Parent Thread Resolver:**
   - If the post is a reply (`parentContext != null`):
     - **Action:** The client UI component asynchronously fetches the full thread hierarchy using the public AppView thread endpoint:
       `https://api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri={post.uri}&depth=5`
     - **Parsing:** Retrieve the full recursive chain of `parent` post objects.
     - **Rendering:** Render the full list of ancestor posts sequentially (from the root post down to the immediate parent post) directly above the target post card.
     - **Thread Rules:**
       - **Zero Truncation:** Render the **entire text** of each ancestor post. Do not cap the number of lines or append ellipses (`...`).
       - **Visual Hierarchy:** Render thin vertical linking lines (e.g. `2px solid #334155`) connecting user avatar icons to visually display the reply indentation hierarchy.
       - **Defaults:** Render the complete thread expanded by default so it is fully visible immediately upon viewing the post.
3. **Post Body (Rich Text):** Parses byte offsets using `facets` to construct clickable HTML links.
4. **Media Embed Box:**
   - **Images:** inline hotlinked thumbnail grid.
   - **External Link Card:** clickable banner.
   - **Video:** HTML5 `<video>` using native HLS (Safari) or `hls.js` script binding (Chrome/Android).
5. **Quoted Context Preview:** Small nested card showing quote post text.
6. **Metadata Footer:** Relative timestamp and Gemini explanation.
7. **Engagement Buttons:** Like button (calls PDS `app.bsky.feed.like`), Follow button (calls PDS `app.bsky.graph.follow`), and Open button (opens `bsky.app`).
8. **Feedback Buttons:**
   - On Desktop: Rendered at the bottom of each card.
   - On Mobile: Handled via the fixed bottom action bar.

---

## 7. Progressive Web App (PWA) Specifications
- Includes `manifest.json` and service worker `sw.js` for standalone app installation.

---

## 8. Design Tokens & Theme Guidelines

| Token Category | Value | Application |
|---|---|---|
| **Typography** | Font Family: `Inter, sans-serif` | Applied globally to all text. |
| **Theme Mode** | Dark Mode Only | Global background: `#0f172a` (Slate 900) / Text color: `#f8fafc` (Slate 50). |
| **Card Styling** | Background: `#1e293b` (Slate 800) | Rounded corners: `8px`. Border: `1px solid #334155`. |
| **Feed Layout** | Max-Width: `640px` (Centered) | Renders as a single-column container with `16px` gaps. |
| **Active States** | Like: `#ef4444` (Red 500) | Filled heart icon when liked. |
| **Active States** | Follow: `#38bdf8` (Sky 400) | Button text changes to "Following". |

---

## 9. Assumptions Log

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A008 | Client-side search and filtering in the UI is not required for version 1. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
