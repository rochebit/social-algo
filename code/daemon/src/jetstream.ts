import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import {
  isFollowed,
  addFirstDegreeFollow,
  removeFirstDegreeFollowByRkey,
  queryLocalPost,
  logProcessingFailure,
  queueForEvaluation,
  deleteFromEvaluationQueue,
  logMetric,
  getLatestMetricTimestamp,
  updateLocalPostFeedback,
  addLocalPost,
  queueOutboxWrite
} from "./db";
import { evaluatePost } from "./gemini";
import { writePost, softDeletePost, initFirestore, getPostId } from "./firestore";

export let lastFirehosePostAt: string | null = null;
export let lastPassedStage1At: string | null = null;

export function initJetstreamState(): void {
  lastFirehosePostAt = getLatestMetricTimestamp("firehose_received");
  lastPassedStage1At = getLatestMetricTimestamp("passed_stage1");
}

const DATA_DIR = path.resolve(__dirname, "../data");
const CURSOR_PATH = path.join(DATA_DIR, "cursor.json");
const CURATED_DEVS_PATH = path.join(DATA_DIR, "curated_devs.json");

// Define Regex pre-filters (Section 3.3)
const REGEX_RULES = [
  // 3.3.1 AT Protocol & Bluesky Keywords
  { name: "keyword:atproto", regex: /\batproto\b/i },
  { name: "keyword:bluesky", regex: /\bbluesky\s+(api|dev|sdk)\b/i },
  { name: "keyword:lexicon", regex: /\blexicon(s)?\b/i },
  { name: "keyword:pds", regex: /\bpds\b/i },
  { name: "keyword:xrpc", regex: /\bxrpc\b/i },
  { name: "keyword:appview", regex: /\bappview\b/i },
  { name: "keyword:did", regex: /\bdid:(plc|web)\b/i },
  { name: "keyword:at-uri", regex: /\bat:\/\/\S+\b/i },
  { name: "keyword:firehose", regex: /\bfirehose\b/i },
  { name: "keyword:jetstream", regex: /\bjetstream\b/i },
  { name: "keyword:relay", regex: /\brelay\b/i },
  { name: "keyword:feed-gen", regex: /\bfeed\s*gen(erator)?\b/i },
  { name: "keyword:labeler", regex: /\blabeler\b/i },
  { name: "keyword:ozone", regex: /\bozone\b/i },
  { name: "keyword:data-repo", regex: /\bdata\s*repo(sitory)?\b/i },
  { name: "keyword:nsid-namespace", regex: /\b(app\.bsky|com\.atproto)\b/i },
  { name: "keyword:bluesky-domain", regex: /\bbsky\.(social|app)\b/i },

  // 3.3.2 ActivityPub & Fediverse Keywords
  { name: "keyword:activitypub", regex: /\bactivitypub\b/i },
  { name: "keyword:fediverse", regex: /\bfediverse\b/i },
  { name: "keyword:mastodon", regex: /\bmastodon\b/i },
  { name: "keyword:webfinger", regex: /\bwebfinger\b/i },
  { name: "keyword:activity-streams", regex: /\bactivity\s*streams\b/i },
  { name: "keyword:nodeinfo", regex: /\bnodeinfo\b/i },
  { name: "keyword:misskey", regex: /\bmisskey\b/i },
  { name: "keyword:pleroma", regex: /\bpleroma\b/i },
  { name: "keyword:lemmy", regex: /\blemmy\b/i },
  { name: "keyword:pixelfed", regex: /\bpixelfed\b/i },
  { name: "keyword:gotosocial", regex: /\bgotosocial\b/i },
  { name: "keyword:akkoma", regex: /\bakkoma\b/i },
  { name: "keyword:sharkey", regex: /\bsharkey\b/i },
  { name: "keyword:federated-timeline", regex: /\bfederated\s+timeline\b/i },

  // 3.3.3 Adjacent Protocols & Standards
  { name: "keyword:nostr", regex: /\bnostr\b/i },
  { name: "keyword:farcaster", regex: /\bfarcaster\b/i },
  { name: "keyword:indieweb", regex: /\bindieweb\b/i },
  { name: "keyword:webmention", regex: /\bwebmention\b/i },
  { name: "keyword:solid", regex: /\bsolid\s+(protocol|pod|project)\b/i },
  { name: "keyword:linked-data", regex: /\blinked\s*data\b/i },

  // 3.3.4 General Open Social Web Keywords
  { name: "keyword:federation", regex: /\bfederat(e|ed|ion|ing)\b/i },
  { name: "keyword:self-host", regex: /\bself-host(ing|ed)?\b/i },
  { name: "keyword:open-social", regex: /\bopen\s+social\b/i },
  { name: "keyword:decentralized", regex: /\bdecentraliz(e|ed|ation|ing)\b/i },
  { name: "keyword:social-web", regex: /\bsocial\s+(web|protocol|graph|interop)\b/i },
  { name: "keyword:protocol-interop", regex: /\bprotocol\s+interop(erability)?\b/i },
  { name: "keyword:social-network-protocol", regex: /\bsocial\s+network\s+(protocol|standard)\b/i }
];

let lastSavedSeq = 0;
let lastSeenSeq = 0;
let ws: WebSocket | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;
let reconnectDelay = 1000; // start at 1s
const MAX_RECONNECT_DELAY = 60000; // max 60s

// Handle cache to avoid redundant profile lookups
const handleCache = new Map<string, string>();

async function resolveDidToHandle(did: string): Promise<string> {
  if (handleCache.has(did)) {
    return handleCache.get(did)!;
  }
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`
    );
    if (res.ok) {
      const profile = (await res.json()) as { handle: string };
      if (profile.handle) {
        handleCache.set(did, profile.handle);
        return profile.handle;
      }
    }
  } catch (error) {
    console.error(`Failed to resolve handle for DID ${did}:`, error);
  }
  return did;
}

/**
 * Load saved cursor sequence from disk.
 */
function loadCursor(): number {
  if (fs.existsSync(CURSOR_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CURSOR_PATH, "utf-8"));
      if (typeof data.seq === "number") {
        lastSavedSeq = data.seq;
        lastSeenSeq = data.seq;
        return data.seq;
      }
    } catch {
      // Ignore reading errors
    }
  }
  return 0;
}

/**
 * Persist the latest cursor sequence to disk.
 */
function saveCursor(): void {
  if (lastSeenSeq > lastSavedSeq) {
    try {
      fs.writeFileSync(CURSOR_PATH, JSON.stringify({ seq: lastSeenSeq }, null, 2));
      lastSavedSeq = lastSeenSeq;
    } catch (error) {
      console.error("Error saving cursor:", error);
    }
  }
}

/**
 * Read the whitelist of curated developer DIDs from disk.
 */
function getCuratedDevs(): Set<string> {
  if (fs.existsSync(CURATED_DEVS_PATH)) {
    try {
      const list = JSON.parse(fs.readFileSync(CURATED_DEVS_PATH, "utf-8")) as string[];
      return new Set(list);
    } catch {
      // Ignore
    }
  }
  return new Set();
}

/**
 * Extracts related author DIDs from a post record (for reply/quote whitelist matching).
 */
function extractDidsFromPost(record: any): string[] {
  const dids: string[] = [];

  // Reply parent / root
  if (record.reply) {
    if (record.reply.parent?.uri) {
      const match = record.reply.parent.uri.match(/^at:\/\/([^\/]+)/);
      if (match) dids.push(match[1]);
    }
    if (record.reply.root?.uri) {
      const match = record.reply.root.uri.match(/^at:\/\/([^\/]+)/);
      if (match) dids.push(match[1]);
    }
  }

  // Quote / embed records
  if (record.embed) {
    if (record.embed.$type === "app.bsky.embed.record" && record.embed.record?.uri) {
      const match = record.embed.record.uri.match(/^at:\/\/([^\/]+)/);
      if (match) dids.push(match[1]);
    } else if (record.embed.record?.record?.uri) {
      const match = record.embed.record.record.uri.match(/^at:\/\/([^\/]+)/);
      if (match) dids.push(match[1]);
    }
  }

  return dids;
}

// -----------------------------------------------------------------------
// Section 7.1 — Facets Parser
// -----------------------------------------------------------------------

export interface ParsedFacet {
  start: number;
  end: number;
  type: "link" | "tag" | "mention";
  uri?: string;
  tag?: string;
  did?: string;
}

/**
 * Parses the ATProto facets array from a Jetstream record into a normalized
 * list using byte-offset indexes.
 */
export function parseFacets(record: any): ParsedFacet[] {
  const facets: ParsedFacet[] = [];
  if (!Array.isArray(record.facets)) return facets;

  for (const facet of record.facets) {
    const start: number = facet.index?.byteStart;
    const end: number = facet.index?.byteEnd;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Array.isArray(facet.features)) continue;

    for (const feature of facet.features) {
      if (feature.$type === "app.bsky.richtext.facet#link") {
        facets.push({ start, end, type: "link", uri: feature.uri });
      } else if (feature.$type === "app.bsky.richtext.facet#tag") {
        facets.push({ start, end, type: "tag", tag: feature.tag });
      } else if (feature.$type === "app.bsky.richtext.facet#mention") {
        facets.push({ start, end, type: "mention", did: feature.did });
      }
    }
  }

  return facets;
}

// -----------------------------------------------------------------------
// Section 7.2 — Media Embed CDN URL Builder
// -----------------------------------------------------------------------

export interface MediaEmbed {
  type: "images" | "external" | "video" | "none";
  images?: { thumbUrl: string; fullsizeUrl: string; alt: string }[];
  externalLink?: { uri: string; title: string; description: string; thumbUrl?: string };
  video?: { playlistUrl: string; thumbnailUrl: string };
}

/**
 * Parses the ATProto embed object and constructs public CDN hotlink URLs.
 */
export function parseMediaEmbed(record: any, authorDid: string): MediaEmbed {
  const embed = record.embed;
  if (!embed) return { type: "none" };

  const embedType: string = embed.$type || "";

  // Images (Section 7.2.1)
  if (embedType === "app.bsky.embed.images") {
    const images: { thumbUrl: string; fullsizeUrl: string; alt: string }[] = [];
    if (Array.isArray(embed.images)) {
      for (const img of embed.images) {
        const blobCid: string | undefined = img.image?.ref?.$link;
        if (blobCid) {
          images.push({
            thumbUrl: `https://cdn.bsky.app/img/feed_thumbnail/plain/${authorDid}/${blobCid}@jpeg`,
            fullsizeUrl: `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/${blobCid}@jpeg`,
            alt: img.alt || ""
          });
        }
      }
    }
    return { type: "images", images };
  }

  // External link card (Section 7.2.2)
  if (embedType === "app.bsky.embed.external") {
    const ext = embed.external || {};
    let thumbUrl: string | undefined;
    const thumbBlobCid: string | undefined = ext.thumb?.ref?.$link;
    if (thumbBlobCid) {
      thumbUrl = `https://cdn.bsky.app/img/feed_thumbnail/plain/${authorDid}/${thumbBlobCid}@jpeg`;
    }
    return {
      type: "external",
      externalLink: {
        uri: ext.uri || "",
        title: ext.title || "",
        description: ext.description || "",
        thumbUrl
      }
    };
  }

  // Video (Section 7.2.3)
  if (embedType === "app.bsky.embed.video") {
    const videoBlobCid: string | undefined = embed.video?.ref?.$link;
    if (videoBlobCid) {
      return {
        type: "video",
        video: {
          playlistUrl: `https://video.cdn.bsky.app/hls/${authorDid}/${videoBlobCid}/playlist.m3u8`,
          thumbnailUrl: `https://video.cdn.bsky.app/hls/${authorDid}/${videoBlobCid}/thumbnail.jpg`
        }
      };
    }
  }

  return { type: "none" };
}

// -----------------------------------------------------------------------
// Section 5 — Thread & Quote Context Retrieval
// -----------------------------------------------------------------------

export interface PostContext {
  uri: string;
  authorHandle: string;
  text: string;
}

/**
 * Fetches post context from the public AppView XRPC API.
 */
async function fetchPostContext(uri: string): Promise<PostContext | null> {
  try {
    const res = await fetch(
      `https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`
    );
    if (!res.ok) {
      throw new Error(`AppView API request timeout: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { posts?: any[] };
    if (!data.posts || data.posts.length === 0) return null;
    const post = data.posts[0];
    return {
      uri: post.uri,
      authorHandle: post.author?.handle || post.author?.did || uri,
      text: post.record?.text || ""
    };
  } catch (error: any) {
    throw new Error(error.message || `HTTP error fetching context: ${error}`);
  }
}

/**
 * Resolves parent post context if the record is a reply (Section 5.1).
 */
export async function resolveParentContext(record: any): Promise<PostContext | null> {
  const parentUri: string | undefined = record.reply?.parent?.uri;
  if (!parentUri) return null;
  return fetchPostContext(parentUri);
}

/**
 * Resolves quoted post context if the record embeds another post (Section 5.2).
 */
export async function resolveQuotedContext(record: any): Promise<PostContext | null> {
  if (!record.embed) return null;
  const embed = record.embed;
  let quotedUri: string | undefined;

  if (embed.$type === "app.bsky.embed.record" && embed.record?.uri) {
    quotedUri = embed.record.uri;
  } else if (embed.$type === "app.bsky.embed.recordWithMedia" && embed.record?.record?.uri) {
    quotedUri = embed.record.record.uri;
  }

  if (!quotedUri) return null;
  return fetchPostContext(quotedUri);
}

// -----------------------------------------------------------------------
// Section 6 — Liked & Reposted Content Resolver
// -----------------------------------------------------------------------

/**
 * Resolves the target post from a repost/like event and routes to Stage 2.
 */
async function handleRepostOrLike(
  commit: any,
  actorDid: string,
  eventType: "repost" | "like"
): Promise<void> {
  const subjectUri: string | undefined = commit.record?.subject?.uri;
  if (!subjectUri) return;

  try {
    const res = await fetch(
      `https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(subjectUri)}`
    );
    if (!res.ok) return;
    const data = (await res.json()) as { posts?: any[] };
    if (!data.posts || data.posts.length === 0) return;

    const targetPost = data.posts[0];
    const targetRecord = targetPost.record || {};
    const targetAuthorDid: string = targetPost.author?.did || subjectUri.split("/")[2];
    const targetHandle: string = targetPost.author?.handle || targetAuthorDid;
    const matchedAt = new Date().toISOString();

    // Resolve actor handle for matchRule label
    const actorHandle = await resolveDidToHandle(actorDid);
    const matchRules = [`${eventType}:${actorHandle}`];

    const facets = parseFacets(targetRecord);
    const mediaEmbed = parseMediaEmbed(targetRecord, targetAuthorDid);
    const parentContext = await resolveParentContext(targetRecord);
    const quotedContext = await resolveQuotedContext(targetRecord);

    const uriParts = subjectUri.split("/");
    const rkey = uriParts[uriParts.length - 1];
    const postUri = `at://${targetAuthorDid}/app.bsky.feed.post/${rkey}`;

    const aiEnabled = process.env.AI_FILTERING_ENABLED !== "false";

    if (!aiEnabled) {
      await writePost({
        uri: postUri,
        cid: targetPost.cid || "",
        authorDid: targetAuthorDid,
        authorHandle: targetHandle,
        text: targetRecord.text || "",
        createdAt: targetRecord.createdAt || matchedAt,
        matchedAt,
        relevanceScore: 100,
        relevanceExplanation: "Bypassed filtering by configuration",
        matchRules,
        isDeleted: false,
        facets,
        mediaEmbed,
        parentContext,
        quotedContext,
        version: process.env.SYSTEM_VERSION || "v1.0.0"
      });
    } else {
      queueForEvaluation({
        uri: postUri,
        cid: targetPost.cid || "",
        authorDid: targetAuthorDid,
        authorHandle: targetHandle,
        text: targetRecord.text || "",
        langs: targetRecord.langs || null,
        facets,
        mediaEmbed,
        matchRules,
        createdAt: targetRecord.createdAt || matchedAt,
        matchedAt,
        reply: targetRecord.reply || null,
        embed: targetRecord.embed || null
      });
    }
  } catch (err) {
    console.error(`Failed to resolve ${eventType} target post ${subjectUri}:`, err);
  }
}

/**
 * Processes user engagement signals (false negative capture) per Section 6.3.
 */
export async function handleUserEngagementFromUri(uri: string, userDid: string): Promise<void> {
  try {
    let exists = false;
    let hasFeedback = false;

    // Check Firestore if possible
    try {
      const db = initFirestore();
      const postId = getPostId(uri);
      const docSnap = await db.collection("posts").doc(postId).get();
      if (docSnap.exists) {
        exists = true;
        const data = docSnap.data();
        if (data && data.feedback !== null && data.feedback !== undefined) {
          hasFeedback = true;
        }
      }
    } catch (err) {
      // Fallback to SQLite
      const localPost = queryLocalPost(uri);
      if (localPost) {
        exists = true;
        if (localPost.feedback !== null && localPost.feedback !== undefined) {
          hasFeedback = true;
        }
      }
    }

    if (exists && hasFeedback) {
      return;
    }

    const currentTimestamp = new Date().toISOString();
    const systemVersion = process.env.SYSTEM_VERSION || "v1.0.0";

    if (exists) {
      try {
        updateLocalPostFeedback(uri, "interacted", currentTimestamp);
      } catch (err) {
        console.error(`Failed to update local post feedback: ${uri}`, err);
      }

      const docData = {
        uri: uri,
        matchRules: ["user_engagement_signal"],
        version: systemVersion,
        feedback: "interacted",
        feedbackAt: currentTimestamp
      };
      queueOutboxWrite(uri, docData);
    } else {
      const res = await fetch(
        `https://api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`
      );
      if (!res.ok) {
        throw new Error(`AppView getPosts returned status: ${res.status}`);
      }
      const data = (await res.json()) as { posts?: any[] };
      if (!data.posts || data.posts.length === 0) {
        return;
      }

      const targetPost = data.posts[0];
      const targetRecord = targetPost.record || {};
      const targetAuthorDid: string = targetPost.author?.did || uri.split("/")[2];
      const targetHandle: string = targetPost.author?.handle || targetAuthorDid;

      const facets = parseFacets(targetRecord);
      const mediaEmbed = parseMediaEmbed(targetRecord, targetAuthorDid);
      
      let parentContext = null;
      let quotedContext = null;
      try {
        parentContext = await resolveParentContext(targetRecord);
        quotedContext = await resolveQuotedContext(targetRecord);
      } catch (err) {
        console.error(`Error resolving context for engagement post: ${uri}`, err);
      }

      const postDoc = {
        uri: uri,
        cid: targetPost.cid || "",
        authorDid: targetAuthorDid,
        authorHandle: targetHandle,
        text: targetRecord.text || "",
        createdAt: targetRecord.createdAt || currentTimestamp,
        matchedAt: currentTimestamp,
        relevanceScore: 100,
        relevanceExplanation: "Direct user engagement signal bypass",
        matchRules: ["user_engagement_signal"],
        feedback: "interacted",
        feedbackAt: currentTimestamp,
        isDeleted: false,
        facets,
        mediaEmbed,
        parentContext,
        quotedContext,
        version: systemVersion
      };

      try {
        addLocalPost(postDoc);
        updateLocalPostFeedback(uri, "interacted", currentTimestamp);
      } catch (err) {
        console.error(`Failed to insert engagement post locally: ${uri}`, err);
      }

      queueOutboxWrite(uri, postDoc);
    }
  } catch (err) {
    console.error(`Error handling user engagement for URI ${uri}:`, err);
  }
}

// -----------------------------------------------------------------------
// Jetstream Connection
// -----------------------------------------------------------------------

const JETSTREAM_HOSTS = [
  "jetstream2.us-east.bsky.network",
  "jetstream1.us-east.bsky.network",
  "jetstream1.us-west.bsky.network",
  "jetstream2.us-west.bsky.network"
];
let currentHostIndex = 0;

/**
 * Starts the Jetstream WebSocket connection.
 * Subscribes to post, follow, repost, and like collections (Section 2.1).
 */
export function startJetstream(userDid: string): void {
  try {
    initJetstreamState();
  } catch (err) {
    console.error("Failed to initialize jetstream state:", err);
  }
  const cursor = loadCursor();
  const host = JETSTREAM_HOSTS[currentHostIndex];
  let url =
    `wss://${host}/subscribe` +
    `?wantedCollections=app.bsky.feed.post` +
    `&wantedCollections=app.bsky.graph.follow` +
    `&wantedCollections=app.bsky.feed.repost` +
    `&wantedCollections=app.bsky.feed.like`;
  if (cursor > 0) {
    url += `&cursor=${cursor}`;
  }

  console.log(`Connecting to Jetstream: ${url}`);
  ws = new WebSocket(url);

  ws.on("open", () => {
    console.log(`Connected to Jetstream firehose on host: ${host}`);
    reconnectDelay = 1000;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (err: any) {
        console.error("Error parsing message payload:", err);
        try {
          logProcessingFailure("post_ingest", data.toString(), err.message || String(err));
        } catch (logErr) {
          console.error("Failed to log post_ingest parse error", logErr);
        }
        return;
      }
      if (message.seq) {
        lastSeenSeq = message.seq;
      }
      if (message.kind === "commit") {
        handleCommit(message, userDid).catch((err) => {
          console.error("Error processing commit:", err);
        });
      }
    } catch (err: any) {
      console.error("General error in WebSocket message handler:", err);
    }
  });

  ws.on("close", () => {
    console.log("Jetstream connection closed. Retrying...");
    scheduleReconnect(userDid);
  });

  ws.on("error", (error) => {
    console.error(`Jetstream WebSocket error on host ${host}:`, error);
    ws?.close();
  });
}

/**
 * Schedules a reconnect with exponential backoff + jitter (Section 2.1).
 */
function scheduleReconnect(userDid: string): void {
  if (reconnectTimeout) return;

  // Cycle host to try next endpoint (Section 2.1 fallback)
  currentHostIndex = (currentHostIndex + 1) % JETSTREAM_HOSTS.length;

  const jitter = Math.random() * 200 - 100; // ±100ms
  const delayWithJitter = reconnectDelay + jitter;
  console.log(`Scheduling reconnect in ${Math.round(delayWithJitter)}ms using host: ${JETSTREAM_HOSTS[currentHostIndex]}`);

  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    startJetstream(userDid);
  }, delayWithJitter);
}

/**
 * Routes a firehose commit to the appropriate handler.
 */
export async function handleCommit(msg: any, userDid: string): Promise<void> {
  const commit = msg.commit;
  if (!commit) return;

  const collection = commit.collection;
  const operation = commit.operation;

  // --- app.bsky.graph.follow (Section 4.3) ---
  if (collection === "app.bsky.graph.follow") {
    try {
      const actorDid = msg.did;
      const rkey = commit.rkey;

      // Only track follows/unfollows performed by the owner (Section 4.3.1 & 4.3.2)
      if (actorDid !== userDid) return;

      if (operation === "create") {
        const subject = commit.record?.subject;
        if (!subject) return;
        console.log(`[Graph Sync] Owner followed: ${subject}`);
        addFirstDegreeFollow(rkey, subject);
      } else if (operation === "delete") {
        const unfollowedDid = removeFirstDegreeFollowByRkey(rkey);
        if (unfollowedDid) {
          console.log(`[Graph Sync] Owner unfollowed: ${unfollowedDid}`);
        }
      }
    } catch (err: any) {
      console.error("[Graph Sync] Error processing follow commit:", err);
      try {
        logProcessingFailure("follow_ingest", JSON.stringify(msg), err.message || String(err));
      } catch (logErr) {
        console.error("Failed to log follow_ingest error", logErr);
      }
    }
  }

  // --- app.bsky.feed.repost / app.bsky.feed.like (Section 6) ---
  else if (
    collection === "app.bsky.feed.repost" ||
    collection === "app.bsky.feed.like"
  ) {
    const eventType: "repost" | "like" =
      collection === "app.bsky.feed.repost" ? "repost" : "like";
    try {
      if (operation !== "create") return; // Deletes are ignored per spec

      const actorDid = msg.did;
      if (actorDid === userDid) {
        const targetUri = commit.record?.subject?.uri;
        if (targetUri) {
          await handleUserEngagementFromUri(targetUri, userDid);
        }
        return;
      }

      if (!isFollowed(actorDid)) return;

      console.log(`[Resolver] ${eventType} by ${actorDid} — resolving target post...`);
      await handleRepostOrLike(commit, actorDid, eventType);
    } catch (err: any) {
      console.error(`[Resolver] Error resolving ${eventType} commit:`, err);
      try {
        const isContext = err.message && err.message.includes("AppView API");
        logProcessingFailure(
          isContext ? "context_fetch" : `${eventType}_ingest`,
          JSON.stringify(msg),
          err.message || String(err)
        );
      } catch (logErr) {
        console.error(`Failed to log ${eventType}_ingest error`, logErr);
      }
    }
  }

  // --- app.bsky.feed.post (Section 2.3 & Stage 1) ---
  else if (collection === "app.bsky.feed.post") {
    try {
      const authorDid = msg.did;
      const rkey = commit.rkey;
      const postUri = `at://${authorDid}/${collection}/${rkey}`;

      // Global Telemetry Update
      logMetric("firehose_received");
      lastFirehosePostAt = new Date().toISOString();

      if (operation === "create") {
        const record = commit.record;
        if (!record || !record.text) return;

        // Check if the author is the user themselves (Section 6.3)
        if (authorDid === userDid) {
          const targetUris = [postUri];
          if (record.reply?.parent?.uri) {
            targetUris.push(record.reply.parent.uri);
          }
          if (record.embed) {
            let quoteUri: string | undefined;
            if (record.embed.$type === "app.bsky.embed.record" && record.embed.record?.uri) {
              quoteUri = record.embed.record.uri;
            } else if (record.embed.$type === "app.bsky.embed.recordWithMedia" && record.embed.record?.record?.uri) {
              quoteUri = record.embed.record.record.uri;
            }
            if (quoteUri) {
              targetUris.push(quoteUri);
            }
          }
          for (const tUri of targetUris) {
            await handleUserEngagementFromUri(tUri, userDid);
          }
          return;
        }

        // 3.1 Language Gate (Preliminary Check)
        if (Array.isArray(record.langs) && record.langs.length > 0 && !record.langs.includes("en")) {
          return;
        }

        let isMatch = false;
        const matchRules: string[] = [];

        // Condition 1: 1st-degree network graph match — bypass keyword filter (Section 3.2)
        if (isFollowed(authorDid)) {
          isMatch = true;
          matchRules.push("network:social-graph");
        } else {
          // Condition 2: Keyword/regex match (Section 3.3)
          for (const rule of REGEX_RULES) {
            if (rule.regex.test(record.text)) {
              isMatch = true;
              matchRules.push(rule.name);
            }
          }

          // Condition 3: Curated whitelist match (Section 3.4)
          const whitelist = getCuratedDevs();
          if (whitelist.has(authorDid)) {
            isMatch = true;
            matchRules.push("whitelist:author");
          } else {
            const postRelations = extractDidsFromPost(record);
            if (postRelations.some((did) => whitelist.has(did))) {
              isMatch = true;
              matchRules.push("whitelist:relation");
            }
          }
        }

        if (!isMatch) return;

        // Stage 1 Pass Telemetry Update
        logMetric("passed_stage1");
        lastPassedStage1At = new Date().toISOString();

        // Matched — resolve handle, parse facets/media/context, then evaluate
        const handle = await resolveDidToHandle(authorDid);
        const matchedAt = new Date().toISOString();

        const facets = parseFacets(record);
        const mediaEmbed = parseMediaEmbed(record, authorDid);

        const aiEnabled = process.env.AI_FILTERING_ENABLED !== "false";

        if (!aiEnabled) {
          // Parent / quote context fetching (Section 5) — wrap in try-catch for context_fetch logging
          let parentContext: PostContext | null = null;
          let quotedContext: PostContext | null = null;
          try {
            parentContext = await resolveParentContext(record);
            quotedContext = await resolveQuotedContext(record);
          } catch (err: any) {
            console.error("[Context Crawl] Error fetching parent/quoted post context:", err);
            try {
              logProcessingFailure("context_fetch", JSON.stringify(msg), err.message || String(err));
            } catch (logErr) {
              console.error("Failed to log context_fetch error", logErr);
            }
          }

          await writePost({
            uri: postUri,
            cid: commit.cid,
            authorDid,
            authorHandle: handle,
            text: record.text,
            createdAt: record.createdAt || matchedAt,
            matchedAt,
            relevanceScore: 100,
            relevanceExplanation: "Bypassed filtering by configuration",
            matchRules,
            isDeleted: false,
            facets,
            mediaEmbed,
            parentContext,
            quotedContext,
            version: process.env.SYSTEM_VERSION || "v1.0.0"
          });
        } else {
          queueForEvaluation({
            uri: postUri,
            cid: commit.cid,
            authorDid,
            authorHandle: handle,
            text: record.text,
            langs: record.langs || null,
            facets,
            mediaEmbed,
            matchRules,
            createdAt: record.createdAt || matchedAt,
            matchedAt,
            reply: record.reply || null,
            embed: record.embed || null
          });
        }
      } else if (operation === "delete") {
        const existing = queryLocalPost(postUri);
        if (existing) {
          await softDeletePost(postUri);
        }
        deleteFromEvaluationQueue(postUri);
      }
    } catch (err: any) {
      console.error("[Post Ingestion] General error processing post commit:", err);
      try {
        logProcessingFailure("post_ingest", JSON.stringify(msg), err.message || String(err));
      } catch (logErr) {
        console.error("Failed to log post_ingest error", logErr);
      }
    }
  }
}

/**
 * Starts periodic cursor persistence (every 5 seconds).
 */
export function startCursorPersistence(): void {
  setInterval(() => {
    saveCursor();
  }, 5000);
}
