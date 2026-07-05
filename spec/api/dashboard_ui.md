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
* 2.2.1. **Session Check:** Render a "Connect Bluesky Account" button inside the collapsible side drawer (Section 4.3) if no active ATProto session token exists in LocalStorage. If connected, render the active user's handle (e.g. `@dev.bsky.social`) alongside a "Disconnect" action button.
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
* 3.3.2. **Visual Placement:** Display the count inside the collapsible side drawer (Section 4.3) adjacent to the `/feed` navigation link (e.g. `Feed ({N})`).
* 3.3.3. **Dynamic Updates:**
  - 3.3.3.1. Decrement the counter UI immediately when the user rates a post.
  - 3.3.3.2. Increment the counter UI immediately when the ingestion daemon syncs a new post match.

### 3.4 PWA Update & Logo Refresh Action
* 3.4.1. **Logo Placement:** Render the application logo inside the collapsible side drawer header.
* 3.4.2. **Click Trigger & Cache Busting:** When the user clicks the logo inside the drawer (or clicks the "Check for Updates" button inside the drawer), the application must:
  - 3.4.2.1. Call the Service Worker registration update method: `registration.update()` to check for a new service worker / newer site version.
  - 3.4.2.2. Trigger a hard reload of the page (`window.location.reload(true)` or equivalent cache-busting reload) to fetch and apply the updated assets immediately without needing to reinstall the PWA.

---

## 4. Layout & Viewport Variations (Mobile vs. Desktop)

The dashboard presents different layouts depending on the user's screen width, optimized for modern high-resolution displays and safe areas (e.g., Pixel 10 Pro XL). To keep the viewport exceptionally clean, secondary features (navigation, user profile, account connection, and detailed backend statistics) sit behind a menu button that toggles a collapsible side drawer.

### 4.1 Mobile Single-Post View (`@media (max-width: 639px)`)
* 4.1.1. **Viewport Constraints & Reset:**
  - 4.1.1.1. **Global Reset:** Reset the `html` and `body` elements explicitly to `margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;` to ensure default browser margins do not cause viewport overflows.
  - 4.1.1.2. **Root Layout Wrapper:** Set the outer root container to `display: flex; flex-direction: column; width: 100vw; height: 100dvh; overflow: hidden; box-sizing: border-box;`.
  - 4.1.1.3. **Top Safe-Area Clearance:** Apply padding to the root layout wrapper `padding-top: env(safe-area-inset-top, 16px)` to prevent status bar/notch overlaps.
* 4.1.2. **Active Post State:** Maintain an integer state variable: `activePostIndex = 0`.
* 4.1.3. **Card Rendering:** Render **only** the single post card matching `posts[activePostIndex]`. Center it on screen with a dynamic viewport height layout.
  - 4.1.3.1. **Height Calculation:** The active card scrollable viewport must be strictly bound to: `height: calc(100dvh - 48px - 72px - env(safe-area-inset-top, 16px) - env(safe-area-inset-bottom, 16px))` (header height is 48px, bottom bar is 72px).
  - 4.1.3.2. **Internal Scroll:** Set `overflow-y: auto` inside the card container to gracefully support long text and deep nested threads.
  - 4.1.3.3. **Bottom Buffer:** Include `padding-bottom: 80px` in the scrollable card box to prevent content clipping behind the fixed action bar.
* 4.1.4. **Fixed Bottom Action Bar:** Render a sticky action bar container:
  - 4.1.4.1. **CSS:** `position: fixed; bottom: 0; left: 0; right: 0; height: calc(72px + env(safe-area-inset-bottom, 16px)); padding-bottom: env(safe-area-inset-bottom, 16px); z-index: 1000; background-color: #1e293b; border-top: 1px solid #334155; display: flex; justify-content: space-around; align-items: center;` (Ensures safe area margins clear native system swipe gestures).
  - 4.1.4.2. **Stability:** Keep buttons completely stationary in the viewport regardless of active card text height.
  - 4.1.4.3. **Skip Button Placement:** Include a dedicated "Skip" button in this bottom action bar, visually styled to distinguish it from the feedback buttons.
* 4.1.5. **Transition Action:** When a feedback button or the Skip button is clicked:
  - 4.1.5.1. **Feedback Click Action:** If a feedback rating is clicked, trigger the Firestore document update to set the rating.
  - 4.1.5.2. **Skip Click Action:** If the Skip button is clicked, do **not** write any feedback to Firestore (leaving the field `null` to allow later review).
  - 4.1.5.3. **Navigation:** Increment `activePostIndex = activePostIndex + 1`.
  - 4.1.5.4. **Transition:** Trigger a horizontal CSS card-swipe slide transition.

### 4.2 Desktop Multi-Post View (`@media (min-width: 640px)`)
* 4.2.1. **Feed Timeline:** Render as a standard vertical feed showing multiple posts in a single scrollable viewport.
* 4.2.2. **Sizing:** Set a maximum width of `640px` and center the feed column on screen.
* 4.2.3. **Action Bar Integration:** Embed an individual feedback button action bar and a dedicated "Skip" button directly inside each card footer.
* 4.2.4. **Skip Action:** Clicking the "Skip" button on a card in desktop view hides/dismisses that post card from the current viewport session (e.g. by adding the post ID to a list of skipped IDs in local component state) without writing any feedback to Firestore.

### 4.3 Collapsible Side Drawer & Compact Header
The top navigation area is minimized to a compact **Header** and an interactive **Side Drawer** to maximize feed real-estate and hide non-essential layouts:
* 4.3.1. **The Compact Header (`#app-header`):**
  - 4.3.1.1. **CSS Layout:** Set header height to `48px`. Flex container: `display: flex; align-items: center; justify-content: space-between; padding: 0 16px; background-color: #0f172a; border-bottom: 1px solid rgba(255,255,255,0.08); z-index: 999;`.
  - 4.3.1.2. **Menu Toggle Button (`#menu-toggle-btn`):** Render a hamburger menu icon (width/height `24px`) on the left to toggle the collapsible side drawer open.
  - 4.3.1.3. **Backend Status Indicator Dot (`#backend-status-dot`):** Render a small circular status dot (width/height `12px`, rounded corners `50%`) representing the daemon state retrieved from Firestore `/stats/backend`:
    - 4.3.1.3.1. **Green (Online):** If the current time is within 7 minutes of `lastActive` AND `geminiFailureCount24h == 0`.
    - 4.3.1.3.2. **Amber (Issues Detected):** If the current time is within 7 minutes of `lastActive` BUT `geminiFailureCount24h > 0` or `lastError != null`.
    - 4.3.1.3.3. **Red (Offline):** If the current time is more than 7 minutes past `lastActive`.
    - 4.3.1.3.4. **Tooltip Info:** Provide a native browser tooltip (`title` attribute) listing quick metrics (e.g. `Status: Online | Queue: {queueSize} | Failures: {geminiFailureCount24h}`).
  - 4.3.1.4. **Header Cleanliness:** No titles, logo icons, username labels, or full review counts may be visible in the main header space.
* 4.3.2. **The Collapsible Side Drawer (`#side-drawer`):**
  - 4.3.2.1. **CSS Layout:** Positioned off-screen by default: `position: fixed; top: 0; left: -280px; width: 280px; height: 100dvh; background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(20px); border-right: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 8px 0 32px rgba(0, 0, 0, 0.5); z-index: 1050; display: flex; flex-direction: column; transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1); box-sizing: border-box;`.
  - 4.3.2.2. **Overlay/Backdrop (`#drawer-backdrop`):** Render a semi-transparent screen overlay (`background-color: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px); z-index: 1040;`) when the drawer is open. Clicking the backdrop closes the drawer.
  - 4.3.2.3. **Drawer Header:** Contains the application logo and a Close button. Clicking the logo triggers the PWA update check and cache-busting reload (Section 3.4.2).
  - 4.3.2.4. **User Profile Section:** Renders Google user profile picture, email address, and a "Sign Out" button.
  - 4.3.2.5. **ATProto Connection Section:** Renders Bluesky credentials status (Section 2.2.1).
  - 4.3.2.6. **Navigation Links:**
    - 4.3.2.6.1. Link to **Feed (`/feed`)** appended with the real-time unreviewed counter: `Feed ({totalUnreviewed})`.
    - 4.3.2.6.2. Link to **Archive (`/archive`)**.
  - 4.3.2.7. **Backend Stats Summary Block (`#backend-stats-panel`):** A visually structured card rendering real-time fields from Firestore `/stats/backend`:
    - 4.3.2.7.1. **Queue Backlog Size:** Rendered text: `Queue: {queueSize} pending`.
    - 4.3.2.7.2. **Gemini 24h Failures:** Rendered text: `Gemini Fails (24h): {geminiFailureCount24h}`.
    - 4.3.2.7.3. **Last Batch Summary:** Rendered text: `Last Batch: {relativeTime} ({lastBatchProcessedCount} posts processed, {lastBatchRelevantCount} matched)`.
    - 4.3.2.7.4. **Last Error Message:** If `lastError` is not null, display it inside a small red-tinted alert block with horizontal scrolling for long stack traces.

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
  - 6.1.2.4. **Ancestor Media Resolution:** If any ancestor post contains media embeds (images, external link cards, or videos), the UI must resolve and render these assets inline directly under the ancestor post's text. Media must be styled and scaled down (e.g., 20% smaller than main post media layout) to preserve visual hierarchy.
  - 6.1.2.5. **Visual Hierarchy:** Render thin vertical linking lines (e.g. `2px solid #334155`) connecting user avatar icons.
  - 6.1.2.6. **Default State:** Render the complete thread expanded by default.
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

The application design must achieve a highly aesthetic, premium look. Generic elements are prohibited.

### 8.1 Color System
* 8.1.1. **Global Background:** Deep slate-to-dark gradient: `linear-gradient(135deg, #090d16 0%, #0f172a 100%)`.
* 8.1.2. **Card Styling:** Frosted glassmorphism containers:
  - 8.1.2.1. Background: `rgba(30, 41, 59, 0.7)`.
  - 8.1.2.2. Backdrop Filter: `blur(16px)`.
  - 8.1.2.3. Borders: `1px solid rgba(255, 255, 255, 0.08)`.
  - 8.1.2.4. Shadow: `0 8px 32px rgba(0, 0, 0, 0.3)`.
  - 8.1.2.5. Corners: `12px` rounded corners.
* 8.1.3. **Relevance Badges:**
  - 8.1.3.1. High Relevance (>80): Emerald gradient `linear-gradient(135deg, #059669 0%, #10b981 100%)`.
  - 8.1.3.2. Mid Relevance (50-80): Amber gradient `linear-gradient(135deg, #d97706 0%, #f59e0b 100%)`.
  - 8.1.3.3. Low Relevance (<50): Slate/Indigo gradient `linear-gradient(135deg, #475569 0%, #64748b 100%)`.
* 8.1.4. **Accent & Interactive Colors:**
  - 8.1.4.1. Primary Indigo/Violet Gradient: `#6366f1` to `#4f46e5`.
  - 8.1.4.2. Like Active: `#ef4444` (Red 500).
  - 8.1.4.3. Follow Active: `#38bdf8` (Sky 400).
  - 8.1.4.4. Double-Minus: `#f97316` (Orange 500).
  - 8.1.4.5. Minus: `#94a3b8` (Slate 400).
  - 8.1.4.6. Plus: `#14b8a6` (Teal 500).
  - 8.1.4.7. Double-Plus: `#3b82f6` (Blue 500).

### 8.2 Typography
* 8.2.1. **Headers and Scores:** Font Family `Outfit`, Sans-serif, Font Weight `700`, letter-spacing `-0.02em`.
* 8.2.2. **Body Text:** Font Family `Inter`, Sans-serif, Font Weight `400`, letter-spacing `-0.011em` for optimal legibility.

### 8.3 Animations & Micro-interactions
* 8.3.1. **Button Scales:** Apply `transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1)` to all buttons. On hover, scale to `1.05`. On active click, scale to `0.95`.
* 8.3.2. **Card Swipes (Mobile):** Horizontal transition when loading the next card: `transition: transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease`.
* 8.3.3. **Refresh Banner Floating:** Floating keyframe animation translating the y-axis:
  ```css
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
  }
  ```

---

## 9. Assumptions Log

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A008 | Client-side search and filtering in the UI is not required for version 1. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |
| A011 | Secondary features and statistics panel are placed inside a collapsible side drawer. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
| A012 | Backend statistics are loaded dynamically from `/stats/backend` in Firestore. | `[CONFIRMED]` | Confirmed by User on 2026-07-05. |
