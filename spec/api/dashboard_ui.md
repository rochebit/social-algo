# Dashboard UI & Layout Specification

This document details the page layout, PWA specifications, component definitions, queries, media rendering, stable viewport interactions, and real-time counters for the Firebase-hosted Web Dashboard.

---

## 1. Application Routing & Views

The dashboard is structured as a single-page application (SPA) containing three primary routes:

* 1.1. **/login:** Unauthenticated landing page featuring a "Sign In with Google" button.
* 1.2. **/feed:** The default authenticated view rendering the unrated custom feed in a stable reading order.
* 1.3. **/archive:** The review history view containing previously rated posts with query/reset controls.

---

## 2. Authentication & Access Control

### 2.1 Firebase Auth Client Flow (Dashboard Access)
* 2.1.1. **Auth Listener:** Initialize check on app load using `firebase.auth().onAuthStateChanged()`.
* 2.1.2. **Unauthenticated Handler:** If the user state is null, redirect the user immediately to `/login`.
* 2.1.3. **Authenticated Handler:** If the user is authenticated:
  - 2.1.3.1. Verify their Google email address against the whitelisted address configured during build time.
  - 2.1.3.2. If the email matches the whitelist: redirect to `/feed`.
  - 2.1.3.3. If the email does not match the whitelist: sign the user out immediately via the SDK and render an "Access Denied" error message.

### 2.2 ATProto OAuth Session (Bluesky Access)
To interact with the Bluesky API for Liking and Following, the app maintains a client-side OAuth session:
* 2.2.1. **Session Check:** Render a "Connect Bluesky Account" button in the dashboard header if no active ATProto session token exists in LocalStorage.
* 2.2.2. **Metadata Endpoint:** The dashboard must serve a valid OAuth client metadata document at `{ORIGIN}/client-metadata.json`.

---

## 3. Stable Viewport Feed Query & Counters

To prevent posts from shifting or moving while reading, the feed does **not** bind a real-time listener directly to the view. Instead, it uses a manual-refresh pagination model.

### 3.1 Consistent Score-Sorted Feed Query
* 3.1.1. **Initialize State:** When `/feed` mounts, record `pageLoadTime = new Date().toISOString()`.
* 3.1.2. **Execute Static Fetch:** Query Firestore once (`.get()`):
  - 3.1.2.1. **Collection:** `posts`
  - 3.1.2.2. **Filters:**
    - `isDeleted == false`
    - `feedback == null`
    - `matchedAt <= pageLoadTime`
  - 3.1.2.3. **Sorting:**
    - First Sort: **`relevanceScore` (Descending)** (shows best posts first)
    - Second Sort: **`matchedAt` (Descending)** (fallback chronological order)
  - 3.1.2.4. **Limit:** Capped at 50 documents.
* 3.1.3. **Render Feed:** Render this static array. The items remain completely stationary.

### 3.2 Dynamic Backlog Tracking (Floating Refresh Banner)
* 3.2.1. **Backlog Listener:** Query the **count** of newer posts where: `isDeleted == false`, `feedback == null`, `matchedAt > pageLoadTime`.
* 3.2.2. **Banner Toggle:** If the count returns `N > 0`, display a floating, sticky banner at the top center of the viewport reading: `[ 🗘 Load {N} new posts ]`.
* 3.2.3. **Click Action:** When clicked, update `pageLoadTime` to the current time, re-run the static query, replace the feed state, and scroll back to the top of the viewport.

### 3.3 Real-Time Review Counter
* 3.3.1. **Query Definition:** The UI establishes a real-time listener snapshot checking the total count of unreviewed items:
  ```javascript
  db.collection('posts')
    .where('isDeleted', '==', false)
    .where('feedback', '==', null)
    .onSnapshot(snapshot => {
      const totalUnreviewed = snapshot.size;
      updateUnreviewedCounterUI(totalUnreviewed);
    });
  ```
* 3.3.2. **Visual Placement:** Display the count prominently in the top header: `[ {N} posts remaining to review ]`.
* 3.3.3. **Dynamic Updates:**
  - 3.3.3.1. Decrement the counter UI immediately when the user rates a post.
  - 3.3.3.2. Increment the counter UI immediately when the ingestion daemon syncs a new post match.

### 3.4 PWA Update & Logo Refresh Action
* 3.4.1. **Logo Placement:** Render the application logo in the top-left corner of the header.
* 3.4.2. **Click Trigger & Cache Busting:** When the user clicks the logo, the application must:
  - 3.4.2.1. Call the Service Worker registration update method: `registration.update()` to check for a new service worker / newer site version.
  - 3.4.2.2. Trigger a hard reload of the page (`window.location.reload(true)` or equivalent cache-busting reload) to fetch and apply the updated assets immediately without needing to reinstall the PWA.

---

## 4. Layout & Viewport Variations (Mobile vs. Desktop)

The dashboard presents different layouts depending on the user's screen width.

### 4.1 Mobile Single-Post View (`@media (max-width: 639px)`)
* 4.1.1. **Viewport Constraints:** Lock the container to `width: 100vw` and height `100dvh` (dynamic viewport height). Disable body scrolling: `overflow: hidden`.
* 4.1.2. **Active Post State:** Maintain an integer state variable: `activePostIndex = 0`.
* 4.1.3. **Card Rendering:** Render **only** the single post card matching `posts[activePostIndex]`. Center it on screen with 100% height and internal scrolling enabled, adding a bottom padding of `80px`.
* 4.1.4. **Fixed Bottom Action Bar:** Render a sticky action bar container:
  - 4.1.4.1. **CSS:** `position: fixed; bottom: 0; left: 0; right: 0; height: 72px; z-index: 1000; background-color: #1e293b; border-top: 1px solid #334155; display: flex; justify-content: space-around; align-items: center;`
  - 4.1.4.2. **Stability:** Keep buttons completely stationary in the viewport regardless of the active card's content length.
  - 4.1.4.3. **Skip Button Placement:** Include a dedicated "Skip" button in this bottom action bar, visually styled to distinguish it from the feedback buttons.
* 4.1.5. **Transition Action:** When a feedback button or the Skip button is clicked:
  - 4.1.5.1. **Feedback Click Action:** If a feedback rating is clicked, trigger the Firestore document update to set the rating.
  - 4.1.5.2. **Skip Click Action:** If the Skip button is clicked, do **not** write any feedback to Firestore (leaving the field `null` to allow later review).
  - 4.1.5.3. **Navigation:** Increment `activePostIndex = activePostIndex + 1`.
  - 4.1.5.4. **Transition:** Trigger a CSS card-swipe slide transition.

### 4.2 Desktop Multi-Post View (`@media (min-width: 640px)`)
* 4.2.1. **Feed Timeline:** Render as a standard vertical feed showing multiple posts in a single scrollable viewport.
* 4.2.2. **Sizing:** Set a maximum width of `640px` and center the feed column on screen.
* 4.2.3. **Action Bar Integration:** Embed an individual feedback button action bar and a dedicated "Skip" button directly inside each card footer.
* 4.2.4. **Skip Action:** Clicking the "Skip" button on a card in desktop view hides/dismisses that post card from the current viewport session (e.g. by adding the post ID to a list of skipped IDs in local component state) without writing any feedback to Firestore.

---

## 5. Extended Feedback & Skip Action Buttons

The UI displays four feedback options and one navigation skip option:

```text
+--------------------------------------------------------+
|  [ -- ]     [ - ]     [ + ]     [ ++ ]      [ Skip ]   |
|  Negative  Neutral  Positive  Extra Pos.     Skip      |
+--------------------------------------------------------+
```

### 5.1 Button Mappings & Actions
* 5.1.1. **`--` / Double Minus Icon (Negative):** Saves `feedback = "negative"` in Firestore.
* 5.1.2. **`-` / Single Minus Icon (Neutral):** Saves `feedback = "neutral"` in Firestore.
* 5.1.3. **`+` / Single Plus Icon (Positive):** Saves `feedback = "positive"` in Firestore.
* 5.1.4. **`++` / Double Plus Icon (Extra Positive):** Saves `feedback = "extra_positive"` in Firestore.
* 5.1.5. **`Skip` Button:** Does not update the `feedback` field in Firestore (remains `null` for later review) and advances the view.

---

## 6. UI Component Specifications (Post Card)

Every post card renders:

### 6.1 Card Elements & Context Previews
* 6.1.1. **Header:** Renders author handle and a color-coded relevance score badge.
* 6.1.2. **Full Parent Thread Resolver:**
  - 6.1.2.1. **Trigger:** Execute if `parentContext != null`.
  - 6.1.2.2. **Query:** Fetch the thread hierarchy from the public AppView:
    `https://api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri={post.uri}&depth=5`
  - 6.1.2.3. **Zero Truncation Rule:** Render the **entire text** of each ancestor post in the reply chain; line clamping and ellipses are strictly prohibited.
  - 6.1.2.4. **Visual Hierarchy:** Render thin vertical linking lines (e.g. `2px solid #334155`) connecting user avatar icons.
  - 6.1.2.5. **Default State:** Render the complete thread expanded by default.
* 6.1.3. **Post Body (Rich Text):** Parse byte offsets using `facets` to construct clickable HTML links.
* 6.1.4. **Media Embed Box:**
  - 6.1.4.1. **Images:** Hotlink thumbnail grid directly from CDN.
  - 6.1.4.2. **External Link Card:** Clickable link preview card.
  - 6.1.4.3. **Video:** HTML5 `<video>` using native HLS (Safari) or `hls.js` script binding (Chrome/Firefox).
* 6.1.5. **Quoted Context Preview:** Render a nested card showing the author and text of the quoted post (`quotedContext`).
* 6.1.6. **Metadata Footer:** Display relative timestamp and the Gemini explanation text.
* 6.1.7. **Engagement Buttons:** Render active Like button (calls PDS `app.bsky.feed.like`), Follow button (calls PDS `app.bsky.graph.follow`), and Open button (opens `https://bsky.app/profile/{authorDid}/post/{rkey}`).
* 6.1.8. **Feedback Action Row:**
  - 6.1.8.1. Desktop: Render inside the card footer (including the feedback options and the Skip button).
  - 6.1.8.2. Mobile: Exclude from card; routing occurs through the fixed action bar (including the feedback options and the Skip button).

---

## 7. Progressive Web App (PWA) Specifications

The application configuration must bundle standard assets to support standalone PWA installation:
* 7.1. **`manifest.json`:** Define app icons, start URL, theme colors, and set `display: standalone`.
* 7.2. **`sw.js` (Service Worker):** Listen for fetch events and cache static assets for offline startup.

---

## 8. Design Tokens & Theme Guidelines

| ID | Token Category | Value | Application |
|---|---|---|---|
| 8.1 | **Typography** | Font Family: `Inter, sans-serif` | Applied globally to all text. |
| 8.2 | **Theme Mode** | Dark Mode Only | Global background: `#0f172a` (Slate 900) / Text color: `#f8fafc` (Slate 50). |
| 8.3 | **Card Styling** | Background: `#1e293b` (Slate 800) | Rounded corners: `8px`. Border: `1px solid #334155`. |
| 8.4 | **Feed Layout** | Max-Width: `640px` (Centered) | Renders as a single-column container with `16px` gaps. |
| 8.5 | **Active States** | Like: `#ef4444` (Red 500) | Filled heart icon when liked. |
| 8.6 | **Active States** | Follow: `#38bdf8` (Sky 400) | Button text changes to "Following". |

---

## 9. Assumptions Log

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A008 | Client-side search and filtering in the UI is not required for version 1. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
