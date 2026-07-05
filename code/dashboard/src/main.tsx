import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  getDocs,
  updateDoc,
  addDoc
} from "firebase/firestore";
import { BrowserOAuthClient } from "@atproto/oauth-client-browser";
import { Agent } from "@atproto/api";
import Hls from "hls.js";
import "./index.css";

// -----------------------------------------------------------------------
// Data Interfaces
// -----------------------------------------------------------------------

interface PostContext {
  uri: string;
  authorHandle: string;
  text: string;
}

interface ParsedFacet {
  start: number;
  end: number;
  type: "link" | "tag" | "mention";
  uri?: string;
  tag?: string;
  did?: string;
}

interface MediaEmbed {
  type: "images" | "external" | "video" | "none";
  images?: { thumbUrl: string; fullsizeUrl: string; alt: string }[];
  externalLink?: { uri: string; title: string; description: string; thumbUrl?: string };
  video?: { playlistUrl: string; thumbnailUrl: string };
}

interface Post {
  id: string;
  uri: string;
  cid: string;
  authorDid: string;
  authorHandle: string;
  text: string;
  createdAt: string;
  matchedAt: string;
  relevanceScore: number;
  relevanceExplanation: string;
  matchRules: string[];
  feedback: "negative" | "neutral" | "positive" | "extra_positive" | null;
  feedbackAt: string | null;
  isDeleted: boolean;
  parentContext?: PostContext | null;
  quotedContext?: PostContext | null;
  facets?: ParsedFacet[];
  mediaEmbed?: MediaEmbed | null;
}

interface BackendStats {
  lastActive: string;
  lastBatchTime: string;
  queueSize: number;
  geminiFailureCount24h: number;
  lastBatchProcessedCount: number;
  lastBatchSuccessCount: number;
  lastBatchRelevantCount: number;
  lastError: string | null;
  backendStatus: string;
}

// -----------------------------------------------------------------------
// Firebase Config & Initialization
// -----------------------------------------------------------------------
const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY;
const FIREBASE_PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const OWNER_EMAIL = import.meta.env.VITE_OWNER_EMAIL || "owner@gmail.com";

const isMockMode =
  !FIREBASE_API_KEY ||
  FIREBASE_API_KEY === "your_api_key_here" ||
  !FIREBASE_PROJECT_ID ||
  import.meta.env.DEV ||
  window.location.search.includes("mock=true");

let firebaseAuth: any = null;
let firestoreDb: any = null;

if (!isMockMode) {
  const firebaseConfig = {
    apiKey: FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || `${FIREBASE_PROJECT_ID}.appspot.com`,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
  };
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
  firebaseAuth = getAuth(app);
  firestoreDb = getFirestore(app);
}

// -----------------------------------------------------------------------
// Mock Data (with rich content for demonstration)
// -----------------------------------------------------------------------
const MOCK_DB_POSTS: Post[] = [
  {
    id: "mock1",
    uri: "at://did:plc:rpqw572o3uowvjscsps5u7e6/app.bsky.feed.post/3ks5z3a2jzk2c",
    cid: "bafyreihymx3...",
    authorDid: "did:plc:rpqw572o3uowvjscsps5u7e6",
    authorHandle: "devguy.bsky.social",
    text: "Check out this new ATProto AppView implementation in Rust! https://github.com/rust-atproto #atproto",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    matchedAt: new Date(Date.now() - 3500000).toISOString(),
    relevanceScore: 85,
    relevanceExplanation: "Post mentions ATProto AppView implementation in Rust with a link to source code.",
    matchRules: ["keyword:atproto", "keyword:appview"],
    feedback: null,
    feedbackAt: null,
    isDeleted: false,
    parentContext: {
      uri: "at://did:plc:anotherdev/app.bsky.feed.post/999",
      authorHandle: "seniorguy.bsky.social",
      text: "Has anyone tried building an AppView in Rust yet?"
    },
    quotedContext: null,
    facets: [
      { start: 58, end: 90, type: "link", uri: "https://github.com/rust-atproto" },
      { start: 91, end: 99, type: "tag", tag: "atproto" }
    ],
    mediaEmbed: {
      type: "external",
      externalLink: {
        uri: "https://github.com/rust-atproto",
        title: "rust-atproto: An AT Protocol AppView in Rust",
        description: "A high-performance AppView indexer built with Rust and Tokio.",
        thumbUrl: "https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:rpqw572o3uowvjscsps5u7e6/bafyimgcid@jpeg"
      }
    }
  },
  {
    id: "mock2",
    uri: "at://did:plc:vp7572o3uowvjscsps5u7e9/app.bsky.feed.post/3ks5z3a2jzk2d",
    cid: "bafyreihymx4...",
    authorDid: "did:plc:vp7572o3uowvjscsps5u7e9",
    authorHandle: "blueskycoder.bsky.social",
    text: "Just completed my self-hosted PDS setup. Running my own slice of the federated social web!",
    createdAt: new Date(Date.now() - 7200000).toISOString(),
    matchedAt: new Date(Date.now() - 7100000).toISOString(),
    relevanceScore: 94,
    relevanceExplanation: "Post mentions self-hosted PDS and federation — highly relevant to the developer community.",
    matchRules: ["keyword:pds", "keyword:self-host"],
    feedback: null,
    feedbackAt: null,
    isDeleted: false,
    parentContext: null,
    quotedContext: null,
    facets: [],
    mediaEmbed: { type: "none" }
  },
  {
    id: "mock3",
    uri: "at://did:plc:j789w572o3uowvjscsps5u7e2/app.bsky.feed.post/3ks5z3a2jzk2e",
    cid: "bafyreihymx5...",
    authorDid: "did:plc:j789w572o3uowvjscsps5u7e2",
    authorHandle: "lexicondoc.bsky.social",
    text: "Drafting a custom ATProto Lexicon definition for cross-app document sharing. Here is the schema:",
    createdAt: new Date(Date.now() - 10800000).toISOString(),
    matchedAt: new Date(Date.now() - 10700000).toISOString(),
    relevanceScore: 78,
    relevanceExplanation: "Post contains discussion of custom ATProto Lexicon schemas.",
    matchRules: ["keyword:lexicon"],
    feedback: null,
    feedbackAt: null,
    isDeleted: false,
    parentContext: null,
    quotedContext: {
      uri: "at://did:plc:anotherguy/app.bsky.feed.post/abc123",
      authorHandle: "protocolnerd.bsky.social",
      text: "I've been thinking about a standard Lexicon for shared document formats across apps. Would love feedback."
    },
    facets: [],
    mediaEmbed: { type: "none" }
  }
];

// -----------------------------------------------------------------------
// Utility Helpers
// -----------------------------------------------------------------------

function getRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// -----------------------------------------------------------------------
// Rich Text Facet Renderer (Section 4.3 — UTF-8 byte-offset slicing)
// -----------------------------------------------------------------------

function renderFacetText(text: string, facets?: ParsedFacet[]): React.ReactNode {
  if (!facets || facets.length === 0) {
    return <span>{text}</span>;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = encoder.encode(text);

  const sorted = [...facets].sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let keyIndex = 0;

  for (const facet of sorted) {
    if (facet.start < cursor || facet.end > bytes.length) continue;

    if (facet.start > cursor) {
      nodes.push(
        <span key={keyIndex++}>{decoder.decode(bytes.slice(cursor, facet.start))}</span>
      );
    }

    const slicedText = decoder.decode(bytes.slice(facet.start, facet.end));

    if (facet.type === "link" && facet.uri) {
      nodes.push(
        <a key={keyIndex++} href={facet.uri} target="_blank" rel="noopener noreferrer" className="facet-link">
          {slicedText}
        </a>
      );
    } else if (facet.type === "tag" && facet.tag) {
      nodes.push(
        <a key={keyIndex++} href={`https://bsky.app/search?q=${encodeURIComponent(`#${facet.tag}`)}`} target="_blank" rel="noopener noreferrer" className="facet-link">
          {slicedText}
        </a>
      );
    } else if (facet.type === "mention" && facet.did) {
      nodes.push(
        <a key={keyIndex++} href={`https://bsky.app/profile/${facet.did}`} target="_blank" rel="noopener noreferrer" className="facet-link">
          {slicedText}
        </a>
      );
    } else {
      nodes.push(<span key={keyIndex++}>{slicedText}</span>);
    }

    cursor = facet.end;
  }

  if (cursor < bytes.length) {
    nodes.push(
      <span key={keyIndex++}>{decoder.decode(bytes.slice(cursor))}</span>
    );
  }

  return <>{nodes}</>;
}

// -----------------------------------------------------------------------
// HLS Video Player Component (Section 4.4)
// -----------------------------------------------------------------------

function VideoPlayer({ video }: { video: { playlistUrl: string; thumbnailUrl: string } }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !video.playlistUrl) return;

    if (el.canPlayType("application/vnd.apple.mpegurl")) {
      el.src = video.playlistUrl;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(video.playlistUrl);
      hls.attachMedia(el);
      return () => {
        hls.destroy();
      };
    }
  }, [video.playlistUrl]);

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      poster={video.thumbnailUrl}
      className="media-video"
    >
      Your browser does not support HTML5 video.
    </video>
  );
}

// -----------------------------------------------------------------------
// Media Embed Renderer (Section 4.4)
// -----------------------------------------------------------------------

function MediaEmbedRenderer({
  mediaEmbed,
  onImageClick
}: {
  mediaEmbed: MediaEmbed;
  onImageClick: (url: string) => void;
}) {
  if (!mediaEmbed || mediaEmbed.type === "none") return null;

  if (mediaEmbed.type === "images" && mediaEmbed.images && mediaEmbed.images.length > 0) {
    return (
      <div className="media-embed">
        <div className={`image-gallery count-${Math.min(mediaEmbed.images.length, 4)}`}>
          {mediaEmbed.images.map((img, i) => (
            <img
              key={i}
              src={img.thumbUrl}
              alt={img.alt || `Image ${i + 1}`}
              className="gallery-image"
              onClick={() => onImageClick(img.fullsizeUrl)}
              title={img.alt}
            />
          ))}
        </div>
      </div>
    );
  }

  if (mediaEmbed.type === "external" && mediaEmbed.externalLink) {
    const { uri, title, description, thumbUrl } = mediaEmbed.externalLink;
    return (
      <div className="media-embed">
        <a href={uri} target="_blank" rel="noopener noreferrer" className="external-link-card">
          {thumbUrl && (
            <img src={thumbUrl} alt={title} className="external-link-thumb" />
          )}
          <div className="external-link-body">
            <div className="external-link-title">{title}</div>
            {description && (
              <div className="external-link-desc">{description}</div>
            )}
            <div className="external-link-url">{new URL(uri).hostname}</div>
          </div>
        </a>
      </div>
    );
  }

  if (mediaEmbed.type === "video" && mediaEmbed.video) {
    return (
      <div className="media-embed">
        <VideoPlayer video={mediaEmbed.video} />
      </div>
    );
  }

  return null;
}

// -----------------------------------------------------------------------
// Parent Thread Resolver (Section 6.1.2 — Zero Truncation Rule)
// -----------------------------------------------------------------------

function mapAppViewEmbed(embed: any): MediaEmbed | null {
  if (!embed) return null;
  const type = embed.$type;

  if (type === "app.bsky.embed.images#view" && Array.isArray(embed.images)) {
    return {
      type: "images",
      images: embed.images.map((img: any) => ({
        thumbUrl: img.thumb,
        fullsizeUrl: img.fullsize,
        alt: img.alt || ""
      }))
    };
  }

  if (type === "app.bsky.embed.external#view" && embed.external) {
    return {
      type: "external",
      externalLink: {
        uri: embed.external.uri,
        title: embed.external.title || "",
        description: embed.external.description || "",
        thumbUrl: embed.external.thumb
      }
    };
  }

  if (type === "app.bsky.embed.video#view" && embed.playlist) {
    return {
      type: "video",
      video: {
        playlistUrl: embed.playlist,
        thumbnailUrl: embed.thumbnail || ""
      }
    };
  }

  if (type === "app.bsky.embed.recordWithMedia#view" && embed.media) {
    return mapAppViewEmbed(embed.media);
  }

  return null;
}

interface ThreadPost {
  uri: string;
  authorHandle: string;
  authorDisplayName?: string;
  authorAvatar?: string;
  text: string;
  mediaEmbed?: MediaEmbed | null;
}

function ThreadView({
  postUri,
  fallbackParent,
  onImageClick
}: {
  postUri: string;
  fallbackParent: PostContext;
  onImageClick: (url: string) => void;
}) {
  const [ancestors, setAncestors] = useState<ThreadPost[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function fetchThread() {
      try {
        const res = await fetch(
          `https://api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(postUri)}&depth=5`
        );
        if (!res.ok) throw new Error("Failed to fetch thread");
        const data = await res.json();
        if (active && data.thread) {
          const list: ThreadPost[] = [];
          let curr = data.thread.parent;
          while (curr) {
            if (curr.post) {
              list.unshift({
                uri: curr.post.uri,
                authorHandle: curr.post.author?.handle || curr.post.author?.did || "unknown",
                authorDisplayName: curr.post.author?.displayName,
                authorAvatar: curr.post.author?.avatar,
                text: curr.post.record?.text || "",
                mediaEmbed: mapAppViewEmbed(curr.post.embed)
              });
            }
            curr = curr.parent;
          }
          setAncestors(list);
        }
      } catch (err: any) {
        if (active) setError(err.message || "Error");
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchThread();
    return () => {
      active = false;
    };
  }, [postUri]);

  if (loading) {
    return (
      <div className="thread-loading">
        <span className="spinner spinner-sm" style={{ display: "inline-block", verticalAlign: "middle", marginRight: "6px" }}></span> Loading thread...
      </div>
    );
  }

  // Fallback to immediate parent context if AppView API fails or returns no ancestors (offline mode / mock)
  if (error || ancestors.length === 0) {
    return (
      <div className="thread-container">
        <div className="thread-node">
          <div className="thread-avatar-container">
            <div className="thread-avatar-placeholder">👤</div>
            <div className="thread-line"></div>
          </div>
          <div className="thread-content">
            <div className="thread-author">
              <span className="thread-display-name">@{fallbackParent.authorHandle}</span>
            </div>
            <div className="thread-text">{fallbackParent.text}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="thread-container">
      {ancestors.map((ancestor) => (
        <div key={ancestor.uri} className="thread-node">
          <div className="thread-avatar-container">
            {ancestor.authorAvatar ? (
              <img src={ancestor.authorAvatar} alt="avatar" className="thread-avatar" />
            ) : (
              <div className="thread-avatar-placeholder">👤</div>
            )}
            <div className="thread-line"></div>
          </div>
          <div className="thread-content">
            <div className="thread-author">
              <span className="thread-display-name">{ancestor.authorDisplayName || `@${ancestor.authorHandle}`}</span>
              {ancestor.authorDisplayName && <span className="thread-handle"> @{ancestor.authorHandle}</span>}
            </div>
            <div className="thread-text">{ancestor.text}</div>
            {ancestor.mediaEmbed && ancestor.mediaEmbed.type !== "none" && (
              <div className="thread-ancestor-media">
                <MediaEmbedRenderer mediaEmbed={ancestor.mediaEmbed} onImageClick={onImageClick} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------
// Main App Component
// -----------------------------------------------------------------------

export function App() {
  const [currentRoute, setCurrentRoute] = useState<string>("/feed");
  const [user, setUser] = useState<any>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  // Responsive UI check (Section 4)
  const [isMobile, setIsMobile] = useState<boolean>(window.innerWidth < 640);
  const [activePostIndex, setActivePostIndex] = useState<number>(0);
  const [swipeDir, setSwipeDir] = useState<"swiping-left" | null>(null);

  // Feed state
  const [posts, setPosts] = useState<Post[]>([]);
  const [isFeedLoading, setIsFeedLoading] = useState<boolean>(false);

  // Stable viewport — Section 3: feedKey triggers a re-fetch
  const [feedKey, setFeedKey] = useState<number>(0);
  const [newPostsCount, setNewPostsCount] = useState<number>(0);
  const pageLoadTimeRef = useRef<string>("");

  // ATProto OAuth state
  const [oauthClient, setOauthClient] = useState<BrowserOAuthClient | null>(null);
  const [bskyUser, setBskyUser] = useState<{ handle?: string; did?: string } | null>(null);
  const [bskyAgent, setBskyAgent] = useState<Agent | null>(null);
  const [likes, setLikes] = useState<Record<string, boolean>>({});
  const [follows, setFollows] = useState<Record<string, boolean>>({});
  const [exitingCards, setExitingCards] = useState<Record<string, boolean>>({});

  // Lightbox state
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);
  const [backendStats, setBackendStats] = useState<BackendStats | null>(null);
  const [isStatusModalOpen, setIsStatusModalOpen] = useState<boolean>(false);

  // Mock data store
  const [mockPostsStore, setMockPostsStore] = useState<Post[]>(MOCK_DB_POSTS);
  const [totalUnreviewed, setTotalUnreviewed] = useState<number>(0);
  const [skippedPostIds, setSkippedPostIds] = useState<Set<string>>(new Set());

  // -----------------------------------------------------------------------
  // Responsive Handler & Scroll Lock
  // -----------------------------------------------------------------------
  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 640;
      setIsMobile(mobile);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    // Locked dynamic viewport height & disabled scrolling on mobile (Section 4.1)
    if (isMobile) {
      document.documentElement.classList.add("mobile-active");
      document.body.classList.add("mobile-active");
    } else {
      document.documentElement.classList.remove("mobile-active");
      document.body.classList.remove("mobile-active");
    }
    return () => {
      document.documentElement.classList.remove("mobile-active");
      document.body.classList.remove("mobile-active");
    };
  }, [isMobile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsStatusModalOpen(false);
      }
    };
    if (isStatusModalOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isStatusModalOpen]);

  const handleLogoClick = async () => {
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.update();
        }
      }
    } catch (err) {
      console.warn("Service worker update failed:", err);
    } finally {
      window.location.reload();
    }
  };

  const handleSkip = (postId: string) => {
    if (isMobile) {
      setSwipeDir("swiping-left");
    } else {
      setExitingCards((prev) => ({ ...prev, [postId]: true }));
    }
    setTimeout(() => {
      if (isMobile) {
        setSwipeDir(null);
        setActivePostIndex((prev) => prev + 1);
      } else {
        setSkippedPostIds((prev) => new Set([...prev, postId]));
        setExitingCards((prev) => {
          const next = { ...prev };
          delete next[postId];
          return next;
        });
      }
    }, 250);
  };

  // Reset active post card index when switching feeds
  useEffect(() => {
    setActivePostIndex(0);
  }, [currentRoute, feedKey]);

  // -----------------------------------------------------------------------
  // Routing
  // -----------------------------------------------------------------------

  const navigateTo = (path: string) => {
    window.history.pushState({}, "", path);
    setCurrentRoute(path);
  };

  useEffect(() => {
    const handlePopState = () => setCurrentRoute(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    const path = window.location.pathname;
    if (path === "/login" || path === "/feed" || path === "/archive") {
      setCurrentRoute(path);
    } else {
      navigateTo("/feed");
    }
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (isMockMode) {
      setUser({
        uid: "mock-uid",
        displayName: "Mock Developer Profile",
        email: OWNER_EMAIL,
        photoURL: "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y"
      });
      setLoading(false);
    } else {
      const unsubscribe = onAuthStateChanged(firebaseAuth, (firebaseUser) => {
        if (firebaseUser) {
          if (firebaseUser.email === OWNER_EMAIL) {
            setUser(firebaseUser);
            setAuthError(null);
            if (currentRoute === "/login") navigateTo("/feed");
          } else {
            setAuthError(`Access Denied: ${firebaseUser.email} is not whitelisted.`);
            firebaseSignOut(firebaseAuth);
            setUser(null);
            navigateTo("/login");
          }
        } else {
          setUser(null);
          navigateTo("/login");
        }
        setLoading(false);
      });
      return unsubscribe;
    }
  }, [currentRoute]);

  useEffect(() => {
    if (!loading && !user && currentRoute !== "/login") {
      navigateTo("/login");
    }
  }, [user, loading, currentRoute]);

  // -----------------------------------------------------------------------
  // ATProto OAuth (Section 2.2)
  // -----------------------------------------------------------------------

  useEffect(() => {
    const initOauth = async () => {
      try {
        const client = await BrowserOAuthClient.load({
          clientId: `${window.location.origin}/client-metadata.json`,
          handleResolver: "https://bsky.social"
        });
        setOauthClient(client);

        const urlObj = new URL(window.location.href);
        if (urlObj.searchParams.has("code") && urlObj.searchParams.has("state")) {
          const { session } = await client.callback(urlObj.searchParams);
          const agent = new Agent(session);
          setBskyAgent(agent);
          localStorage.setItem("atproto_did", session.did);
          window.history.replaceState({}, "", "/feed");
          setCurrentRoute("/feed");
        }

        const savedDid = localStorage.getItem("atproto_did");
        if (savedDid) {
          try {
            const session = await client.restore(savedDid);
            const agent = new Agent(session);
            setBskyAgent(agent);
            const profile = await agent.getProfile({ actor: session.did });
            setBskyUser({ handle: profile.data.handle, did: session.did });
          } catch {
            localStorage.removeItem("atproto_did");
          }
        }
      } catch (err) {
        console.error("Error loading ATProto OAuth Client:", err);
      }
    };
    initOauth();
  }, []);

  const handleConnectBsky = async () => {
    if (!oauthClient) return;
    const handle = prompt("Enter your Bluesky handle (e.g. yourname.bsky.social):");
    if (!handle) return;
    try {
      await oauthClient.signIn(handle);
    } catch (err) {
      alert(`Bluesky Connection Failed: ${err}`);
    }
  };

  const handleDisconnectBsky = () => {
    localStorage.removeItem("atproto_did");
    setBskyUser(null);
    setBskyAgent(null);
  };

  // -----------------------------------------------------------------------
  // Feed Data — Stable Viewport (Section 3) + Archive
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!user) return;
    setIsFeedLoading(true);
    setNewPostsCount(0);

    if (isMockMode) {
      const filtered = mockPostsStore.filter((post) =>
        currentRoute === "/feed"
          ? !post.isDeleted && post.feedback === null
          : post.feedback !== null
      );
      filtered.sort((a, b) => {
        if (currentRoute === "/feed") {
          if (b.relevanceScore !== a.relevanceScore) {
            return b.relevanceScore - a.relevanceScore;
          }
          return new Date(b.matchedAt).getTime() - new Date(a.matchedAt).getTime();
        }
        return (
          new Date(b.feedbackAt || 0).getTime() -
          new Date(a.feedbackAt || 0).getTime()
        );
      });
      setPosts(filtered);
      setTotalUnreviewed(mockPostsStore.filter(p => !p.isDeleted && p.feedback === null).length);
      setIsFeedLoading(false);
      return;
    }

    // Live mode unreviewed total counter listener
    const unreviewedQ = query(
      collection(firestoreDb, "posts"),
      where("isDeleted", "==", false),
      where("feedback", "==", null)
    );
    const unsubscribeUnreviewed = onSnapshot(unreviewedQ, (snapshot) => {
      setTotalUnreviewed(snapshot.size);
    });

    if (currentRoute === "/feed") {
      const plt = new Date().toISOString();
      pageLoadTimeRef.current = plt;

      // Query posts sorted by relevance score first
      const feedQ = query(
        collection(firestoreDb, "posts"),
        where("isDeleted", "==", false),
        where("feedback", "==", null),
        orderBy("relevanceScore", "desc"),
        orderBy("matchedAt", "desc"),
        limit(100)
      );

      getDocs(feedQ)
        .then((snapshot) => {
          const list: Post[] = [];
          snapshot.forEach((d) => list.push({ id: d.id, ...d.data() } as Post));
          // Client-side matchedTime filter to resolve Firestore constraint
          const filteredList = list
            .filter((p) => p.matchedAt <= plt)
            .slice(0, 50);
          setPosts(filteredList);
          setIsFeedLoading(false);
        })
        .catch((err) => {
          console.error("Feed fetch error:", err);
          setIsFeedLoading(false);
        });

      const countQ = query(
        collection(firestoreDb, "posts"),
        where("isDeleted", "==", false),
        where("feedback", "==", null),
        where("matchedAt", ">", plt)
      );
      const unsubscribeCount = onSnapshot(countQ, (snapshot) => {
        setNewPostsCount(snapshot.size);
      });
      
      return () => {
        unsubscribeCount();
        unsubscribeUnreviewed();
      };

    } else {
      const archiveQ = query(
        collection(firestoreDb, "posts"),
        where("feedback", "!=", null),
        orderBy("feedback", "asc"),
        orderBy("matchedAt", "desc"),
        limit(50)
      );
      getDocs(archiveQ)
        .then((snapshot) => {
          const list: Post[] = [];
          snapshot.forEach((d) => list.push({ id: d.id, ...d.data() } as Post));
          list.sort(
            (a, b) =>
              new Date(b.feedbackAt || 0).getTime() -
              new Date(a.feedbackAt || 0).getTime()
          );
          setPosts(list);
          setIsFeedLoading(false);
        })
        .catch((err) => {
          console.error("Archive fetch error:", err);
          setIsFeedLoading(false);
        });

      return () => {
        unsubscribeUnreviewed();
      };
    }
  }, [user, currentRoute, mockPostsStore, feedKey]);

  useEffect(() => {
    if (isMockMode) {
      setBackendStats({
        lastActive: new Date().toISOString(),
        lastBatchTime: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        queueSize: 12,
        geminiFailureCount24h: 0,
        lastBatchProcessedCount: 45,
        lastBatchSuccessCount: 45,
        lastBatchRelevantCount: 3,
        lastError: null,
        backendStatus: "online"
      });
      return;
    }

    if (!user || !firestoreDb) return;

    const docRef = doc(firestoreDb, "stats", "backend");
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        setBackendStats(docSnap.data() as BackendStats);
      } else {
        console.warn("Backend stats document does not exist.");
      }
    }, (error) => {
      console.error("Error listening to backend stats:", error);
    });

    return () => unsubscribe();
  }, [user]);

  const handleLoadNewPosts = () => {
    setFeedKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // -----------------------------------------------------------------------
  // Four-Tier Feedback Actions (Section 5)
  // -----------------------------------------------------------------------

  const handleFeedback = async (
    postId: string,
    feedbackValue: "negative" | "neutral" | "positive" | "extra_positive"
  ) => {
    if (isMobile) {
      setSwipeDir("swiping-left");
    } else {
      setExitingCards((prev) => ({ ...prev, [postId]: true }));
    }

    setTimeout(async () => {
      const now = new Date().toISOString();
      const post = posts.find((p) => p.id === postId);
      if (!post) return;

      if (isMockMode) {
        setMockPostsStore((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, feedback: feedbackValue, feedbackAt: now } : p))
        );
      } else {
        try {
          await updateDoc(doc(firestoreDb, "posts", postId), {
            feedback: feedbackValue,
            feedbackAt: now
          });
          await addDoc(collection(firestoreDb, "feedback_logs"), {
            postId: post.id,
            postUri: post.uri,
            authorDid: post.authorDid,
            feedback: feedbackValue,
            submittedAt: now,
            userEmail: user?.email || OWNER_EMAIL
          });
        } catch (err) {
          console.error("Error setting feedback:", err);
        }
      }

      if (isMobile) {
        setSwipeDir(null);
        setActivePostIndex((prev) => prev + 1);
      } else {
        setExitingCards((prev) => {
          const next = { ...prev };
          delete next[postId];
          return next;
        });
      }
    }, 250);
  };

  const handleResetFeedback = async (postId: string) => {
    if (isMobile) {
      setSwipeDir("swiping-left");
    }
    setTimeout(async () => {
      if (isMockMode) {
        setMockPostsStore((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, feedback: null, feedbackAt: null } : p))
        );
      } else {
        try {
          await updateDoc(doc(firestoreDb, "posts", postId), { feedback: null, feedbackAt: null });
        } catch (err) {
          console.error("Error resetting feedback:", err);
        }
      }
      if (isMobile) {
        setSwipeDir(null);
        setActivePostIndex((prev) => prev + 1);
      }
    }, 250);
  };

  // -----------------------------------------------------------------------
  // ATProto Direct Engagement (Like & Follow)
  // -----------------------------------------------------------------------

  const handleLike = async (postUri: string, postCid: string) => {
    if (!bskyAgent) { alert("Please connect your Bluesky Account first."); return; }
    try {
      await bskyAgent.com.atproto.repo.createRecord({
        repo: bskyAgent.did!,
        collection: "app.bsky.feed.like",
        record: { $type: "app.bsky.feed.like", subject: { uri: postUri, cid: postCid }, createdAt: new Date().toISOString() }
      });
      setLikes((prev) => ({ ...prev, [postUri]: true }));
    } catch (err) {
      alert(`Like Failed: ${err}`);
    }
  };

  const handleFollow = async (authorDid: string) => {
    if (!bskyAgent) { alert("Please connect your Bluesky Account first."); return; }
    try {
      await bskyAgent.com.atproto.repo.createRecord({
        repo: bskyAgent.did!,
        collection: "app.bsky.graph.follow",
        record: { $type: "app.bsky.graph.follow", subject: authorDid, createdAt: new Date().toISOString() }
      });
      setFollows((prev) => ({ ...prev, [authorDid]: true }));
    } catch (err) {
      alert(`Follow Failed: ${err}`);
    }
  };

  // -----------------------------------------------------------------------
  // Render Components
  // -----------------------------------------------------------------------



  const getBackendStatus = (stats: BackendStats | null) => {
    if (!stats) return { color: "red", label: "Offline", tooltip: "Status: Offline | No stats available" };
    
    const lastActiveDate = new Date(stats.lastActive);
    const now = new Date();
    const diffMins = (now.getTime() - lastActiveDate.getTime()) / 60000;
    
    const isRecent = diffMins <= 7;
    const hasIssues = stats.geminiFailureCount24h > 0 || stats.lastError !== null;
    
    if (isRecent) {
      if (hasIssues) {
        return {
          color: "amber",
          label: "Issues Detected",
          tooltip: `Status: Issues | Queue: ${stats.queueSize} | Failures: ${stats.geminiFailureCount24h}`
        };
      } else {
        return {
          color: "green",
          label: "Online",
          tooltip: `Status: Online | Queue: ${stats.queueSize} | Failures: ${stats.geminiFailureCount24h}`
        };
      }
    } else {
      return {
        color: "red",
        label: "Offline",
        tooltip: `Status: Offline (Last Active: ${getRelativeTime(stats.lastActive)}) | Queue: ${stats.queueSize} | Failures: ${stats.geminiFailureCount24h}`
      };
    }
  };

  const renderHeader = () => {
    const status = getBackendStatus(backendStats);
    return (
      <header id="app-header">
        <button id="menu-toggle-btn" onClick={() => setIsDrawerOpen(true)} title="Open side drawer">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <div 
          id="backend-status-dot" 
          className={`status-dot ${status.color}`} 
          title={status.tooltip} 
          onClick={() => setIsStatusModalOpen(true)}
          style={{ cursor: "pointer" }}
        />
      </header>
    );
  };

  const getFeedbackLabel = (fb: Post["feedback"]) => {
    switch (fb) {
      case "negative": return "Negative (--)";
      case "neutral": return "Neutral (-)";
      case "positive": return "Positive (+)";
      case "extra_positive": return "Extra Pos. (++)";
      default: return "";
    }
  };

  const getFeedbackClass = (fb: Post["feedback"]) => {
    switch (fb) {
      case "negative": return "archive-negative";
      case "neutral": return "archive-neutral";
      case "positive": return "archive-positive";
      case "extra_positive": return "archive-extra-positive";
      default: return "";
    }
  };

  // Render Post Card
  const renderPostCard = (post: Post, displayActions = true) => {
    const isExiting = exitingCards[post.id];
    let scoreClass = "medium";
    if (post.relevanceScore >= 80) scoreClass = "high";
    else if (post.relevanceScore < 50) scoreClass = "low";
    if (post.relevanceExplanation === "AI filtering bypassed") scoreClass = "bypass";

    const uriParts = post.uri.split("/");
    const rkey = uriParts[uriParts.length - 1];
    const bskyPostLink = `https://bsky.app/profile/${post.authorDid}/post/${rkey}`;

    return (
      <div className={`post-card ${isExiting ? "post-card-exit" : ""} ${swipeDir || ""}`} key={post.id}>

        {/* Card Header */}
        <div className="post-header">
          <div className="post-author">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
            <a href={`https://bsky.app/profile/${post.authorDid}`} className="author-link" target="_blank" rel="noopener noreferrer">
              @{post.authorHandle}
            </a>
          </div>
          {currentRoute === "/feed" ? (
            <div className={`score-badge ${scoreClass}`}>{post.relevanceScore} Score</div>
          ) : (
            <div className={`score-badge ${getFeedbackClass(post.feedback)}`}>
              {getFeedbackLabel(post.feedback)}
            </div>
          )}
        </div>

        {/* Parent Context Thread Resolver (Section 6.1.2) */}
        {post.parentContext && (
          <ThreadView postUri={post.uri} fallbackParent={post.parentContext} onImageClick={setLightboxUrl} />
        )}

        {/* Post Body with Facet-based Rich Text (Section 4.3) */}
        <div className="post-body">
          {renderFacetText(post.text, post.facets)}
        </div>

        {/* Media Embed (Section 4.4) */}
        {post.mediaEmbed && (
          <MediaEmbedRenderer
            mediaEmbed={post.mediaEmbed}
            onImageClick={(url) => setLightboxUrl(url)}
          />
        )}

        {/* Quoted Context Preview (Section 4.5) */}
        {post.quotedContext && (
          <div className="context-card quoted-context">
            <div className="context-author">@{post.quotedContext.authorHandle}</div>
            <div className="context-text">{post.quotedContext.text}</div>
          </div>
        )}

        {/* Metadata Footer (Section 4.6) */}
        <div className="post-meta">
          <div className="meta-time">{getRelativeTime(post.createdAt)}</div>
          <div className="meta-reason">{post.relevanceExplanation}</div>
          {post.matchRules && post.matchRules.length > 0 && (
            <div className="meta-rules">
              {post.matchRules.map((rule, i) => (
                <span className="rule-tag" key={i}>{rule}</span>
              ))}
            </div>
          )}
        </div>

        {/* Action Bar (Only rendered on desktop or for non-feedback actions on mobile) */}
        <div className="action-bar">
          <div className="action-group">
            {!isMobile && displayActions && (
              currentRoute === "/feed" ? (
                <>
                  <button className="btn btn-sm btn-fb" style={{ color: "var(--danger)" }} onClick={() => handleFeedback(post.id, "negative")} title="Negative (--)">
                    --
                  </button>
                  <button className="btn btn-sm btn-fb" style={{ color: "var(--grey)" }} onClick={() => handleFeedback(post.id, "neutral")} title="Neutral (-)">
                    -
                  </button>
                  <button className="btn btn-sm btn-fb" style={{ color: "var(--primary)" }} onClick={() => handleFeedback(post.id, "positive")} title="Positive (+)">
                    +
                  </button>
                  <button className="btn btn-sm btn-fb" style={{ color: "var(--success)" }} onClick={() => handleFeedback(post.id, "extra_positive")} title="Extra Positive (++)">
                    ++
                  </button>
                  <button className="btn btn-sm btn-fb btn-skip" style={{ color: "var(--text-muted)", marginLeft: "8px" }} onClick={() => handleSkip(post.id)} title="Skip post (without rating)">
                    Skip
                  </button>
                </>
              ) : (
                <button className="btn btn-sm" onClick={() => handleResetFeedback(post.id)}>
                  🔄 Reset
                </button>
              )
            )}
          </div>
          <div className="action-group">
            {currentRoute === "/feed" && (
              <>
                <button
                  className={`btn btn-sm btn-like ${likes[post.uri] ? "liked" : ""}`}
                  disabled={!bskyAgent || !!likes[post.uri]}
                  onClick={() => handleLike(post.uri, post.cid)}
                >
                  {likes[post.uri] ? "❤️" : "🤍"}
                </button>
                <button
                  className={`btn btn-sm btn-follow ${follows[post.authorDid] ? "following" : ""}`}
                  disabled={!bskyAgent || !!follows[post.authorDid]}
                  onClick={() => handleFollow(post.authorDid)}
                >
                  {follows[post.authorDid] ? "Following" : "👤 Follow"}
                </button>
              </>
            )}
            <a href={bskyPostLink} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
              🌐 Open
            </a>
          </div>
        </div>
      </div>
    );
  };

  // -----------------------------------------------------------------------
  // Render Viewports (Mobile vs Desktop)
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="spinner"></div>
      </div>
    );
  }

  if (currentRoute === "/login") {
    return (
      <div className="login-view">
        <div className="login-card">
          <h2>Feed Monitor</h2>
          <p>Sign in with your authorized Google Account to access the developer firehose dashboard.</p>
          {authError && <div className="login-error">{authError}</div>}
          <button className="google-btn" onClick={() => {
            if (isMockMode) {
              setUser({ uid: "mock-uid", displayName: "Mock Developer Profile", email: OWNER_EMAIL, photoURL: "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y" });
              navigateTo("/feed");
            } else {
              signInWithPopup(firebaseAuth, new GoogleAuthProvider()).catch((err) => {
                setAuthError(`Sign-in failed: ${err.message}`);
              });
            }
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22c-.23-.66-.35-1.36-.35-2.09z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Continue with Google
          </button>
          {isMockMode && (
            <p style={{ fontSize: "0.75rem", color: "var(--amber)", fontStyle: "italic" }}>
              ⚠️ Firebase config missing. Running in Local Mock Mode.
            </p>
          )}
        </div>
      </div>
    );
  }

  const renderStatusModal = () => {
    if (!isStatusModalOpen) return null;
    const stats = backendStats || {
      lastActive: new Date().toISOString(),
      lastBatchTime: new Date().toISOString(),
      queueSize: 0,
      geminiFailureCount24h: 0,
      lastBatchProcessedCount: 0,
      lastBatchSuccessCount: 0,
      lastBatchRelevantCount: 0,
      lastError: null,
      backendStatus: "online"
    };

    const status = getBackendStatus(stats);
    const lastActiveStr = stats.lastActive ? `${stats.lastActive} (${getRelativeTime(stats.lastActive)})` : "N/A";
    const lastBatchTimeStr = stats.lastBatchTime ? stats.lastBatchTime : "N/A";

    return (
      <>
        <div id="modal-backdrop" onClick={() => setIsStatusModalOpen(false)} />
        <div id="backend-status-modal">
          <button className="modal-close-btn" onClick={() => setIsStatusModalOpen(false)} title="Close modal">✕</button>
          
          <div className="modal-header">
            <h3>Backend Status: <span className={`status-text ${status.color}`}>{status.label.toUpperCase()}</span></h3>
            <div className={`status-dot ${status.color}`} style={{ width: "12px", height: "12px", border: "none" }} />
          </div>

          <div className="modal-body">
            <div className="metric-row">
              <span className="metric-label">Active Heartbeat:</span>
              <span className="metric-value">{lastActiveStr}</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Queue Status:</span>
              <span className="metric-value">Queue Backlog: {stats.queueSize} posts pending evaluation in SQLite</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Gemini Failures (24h):</span>
              <span className="metric-value">Gemini API Failures (24h): {stats.geminiFailureCount24h}</span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Last Batch Telemetry:</span>
              <span className="metric-value">
                Last Batch Run: Completed at {lastBatchTimeStr}. Selected {stats.lastBatchProcessedCount} posts. Classified {stats.lastBatchSuccessCount} successfully, finding {stats.lastBatchRelevantCount} relevant posts.
              </span>
            </div>

            {stats.lastError && (
              <div className="error-alert-card">
                <div className="error-alert-header">
                  <span>Recent Error Alert:</span>
                  <button 
                    className="btn-copy-error" 
                    onClick={() => {
                      navigator.clipboard.writeText(stats.lastError || "");
                      alert("Error copied to clipboard!");
                    }}
                  >
                    Copy Error
                  </button>
                </div>
                <pre className="error-pre">{stats.lastError}</pre>
              </div>
            )}
          </div>
        </div>
      </>
    );
  };

  // Active Post for mobile single card rendering
  const activePost = posts[activePostIndex];

  return (
    <div className="app-root-wrapper">
      {renderHeader()}
      {renderStatusModal()}

      {/* Drawer Backdrop Overlay */}
      {isDrawerOpen && (
        <div id="drawer-backdrop" onClick={() => setIsDrawerOpen(false)} />
      )}

      {/* Collapsible Side Drawer */}
      <div id="side-drawer" className={isDrawerOpen ? "open" : ""}>
        <div className="drawer-header">
          <div className="drawer-logo" onClick={handleLogoClick} style={{ cursor: "pointer" }} title="Click to refresh and check for updates">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--primary)" }}>
              <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
              <polyline points="2 17 12 22 22 17"></polyline>
              <polyline points="2 12 12 17 22 12"></polyline>
            </svg>
            <h2>ATProto</h2>
          </div>
          <button id="close-drawer-btn" className="close-btn" onClick={() => setIsDrawerOpen(false)} title="Close drawer">✕</button>
        </div>

        {user && (
          <div className="drawer-profile">
            <img src={user.photoURL} alt="Avatar" />
            <div className="profile-info">
              <span className="profile-name">{user.displayName || "Owner"}</span>
              <span className="profile-email">{user.email}</span>
            </div>
            <button className="btn btn-sm btn-outline-danger" onClick={() => {
              if (isMockMode) { setUser(null); navigateTo("/login"); }
              else firebaseSignOut(firebaseAuth);
              setIsDrawerOpen(false);
            }}>Sign Out</button>
          </div>
        )}

        <div className="drawer-connection">
          {bskyUser ? (
            <div className="bsky-status connected">
              <span>🦋 @{bskyUser.handle}</span>
              <button className="btn btn-sm btn-danger" onClick={() => { handleDisconnectBsky(); setIsDrawerOpen(false); }}>Disconnect</button>
            </div>
          ) : (
            <button className="btn btn-sm btn-primary w-100" onClick={() => { handleConnectBsky(); setIsDrawerOpen(false); }}>Connect Bluesky</button>
          )}
        </div>

        <nav className="drawer-nav">
          <button className={`nav-link-btn ${currentRoute === "/feed" ? "active" : ""}`} onClick={() => { navigateTo("/feed"); setIsDrawerOpen(false); }}>
            <span>📰 Feed ({totalUnreviewed})</span>
          </button>
          <button className={`nav-link-btn ${currentRoute === "/archive" ? "active" : ""}`} onClick={() => { navigateTo("/archive"); setIsDrawerOpen(false); }}>
            <span>📁 Archive</span>
          </button>
        </nav>

        {backendStats && (
          <div id="backend-stats-panel">
            <h3>Backend Status</h3>
            <div className="stats-metric">
              <span className="label">Queue:</span>
              <span className="value">{backendStats.queueSize} pending</span>
            </div>
            <div className="stats-metric">
              <span className="label">Gemini Fails (24h):</span>
              <span className="value">{backendStats.geminiFailureCount24h}</span>
            </div>
            <div className="stats-metric">
              <span className="label">Last Batch:</span>
              <span className="value">
                {getRelativeTime(backendStats.lastBatchTime)} ({backendStats.lastBatchProcessedCount} posts processed, {backendStats.lastBatchRelevantCount} matched)
              </span>
            </div>
            {backendStats.lastError && (
              <div className="stats-error-alert">
                <div className="alert-header">Last Error</div>
                <div className="alert-body">{backendStats.lastError}</div>
              </div>
            )}
            <button className="btn btn-sm btn-outline-primary check-updates-btn" style={{ marginTop: "1rem", width: "100%" }} onClick={handleLogoClick}>
              Check for Updates
            </button>
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxUrl} alt="Full size" className="lightbox-image" />
            <button className="lightbox-close" onClick={() => setLightboxUrl(null)}>✕</button>
          </div>
        </div>
      )}

      {/* Floating Refresh Banner */}
      {currentRoute === "/feed" && newPostsCount > 0 && (
        <div className="refresh-banner" onClick={handleLoadNewPosts}>
          🗘 Load {newPostsCount} new {newPostsCount === 1 ? "post" : "posts"}
        </div>
      )}

      {isMobile ? (
        /* Mobile Viewport Layout: Locked fullscreen single card, dynamic bottom bar (Section 4.1) */
        <div className="mobile-view-wrapper">
          <div className="mobile-viewport">
            {isFeedLoading ? (
              <div className="state-message">
                <div className="spinner"></div>
                <p>Loading card...</p>
              </div>
            ) : !activePost ? (
              <div className="state-message">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                <p>No posts available.</p>
              </div>
            ) : (
              <div className="mobile-card-container">
                {renderPostCard(activePost, false)}
              </div>
            )}
          </div>

          {/* Fixed Bottom Action Bar: Stable location on screen (Section 4.1) */}
          <div className="mobile-bottom-bar">
            {activePost && (
              currentRoute === "/feed" ? (
                <>
                  <button className="btn btn-fb-mobile" onClick={() => handleFeedback(activePost.id, "negative")} style={{ color: "var(--danger)" }}>
                    <span className="fb-symbol">--</span>
                    <span className="fb-label">Negative</span>
                  </button>
                  <button className="btn btn-fb-mobile" onClick={() => handleFeedback(activePost.id, "neutral")} style={{ color: "var(--grey)" }}>
                    <span className="fb-symbol">-</span>
                    <span className="fb-label">Neutral</span>
                  </button>
                  <button className="btn btn-fb-mobile" onClick={() => handleFeedback(activePost.id, "positive")} style={{ color: "var(--primary)" }}>
                    <span className="fb-symbol">+</span>
                    <span className="fb-label">Positive</span>
                  </button>
                  <button className="btn btn-fb-mobile" onClick={() => handleFeedback(activePost.id, "extra_positive")} style={{ color: "var(--success)" }}>
                    <span className="fb-symbol">++</span>
                    <span className="fb-label">Extra Pos.</span>
                  </button>
                  <button className="btn btn-fb-mobile btn-skip-mobile" onClick={() => handleSkip(activePost.id)} style={{ color: "var(--text-muted)" }}>
                    <span className="fb-symbol">↷</span>
                    <span className="fb-label">Skip</span>
                  </button>
                </>
              ) : (
                <button className="btn btn-reset-mobile" onClick={() => handleResetFeedback(activePost.id)}>
                  🔄 Reset Rating
                </button>
              )
            )}
          </div>
        </div>
      ) : (
        /* Desktop Viewport Layout: Multi-post timeline feed (Section 4.2) */
        <main className="app-container">
          {isMockMode && (
            <div className="mock-mode-banner">
              <strong>⚠️ Running in Local Mock Mode</strong>
              <span>Add your Firebase configuration to <code>.env</code> to connect to the live database.</span>
            </div>
          )}

          {isFeedLoading ? (
            <div className="state-message">
              <div className="spinner"></div>
              <p>Loading feed...</p>
            </div>
          ) : (
            <div className="feed-container">
              {posts.length === 0 ? (
                <div className="state-message">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="16" y1="2" x2="16" y2="6"></line>
                    <line x1="8" y1="2" x2="8" y2="6"></line>
                    <line x1="3" y1="10" x2="21" y2="10"></line>
                  </svg>
                  {currentRoute === "/feed" ? (
                    <p>All matching posts have been rated. Firehose monitor is catching up...</p>
                  ) : (
                    <p>No posts archived yet. Rate posts in the Custom Feed to populate this archive.</p>
                  )}
                </div>
              ) : (
                posts.filter((p) => !skippedPostIds.has(p.id)).map((post) => renderPostCard(post))
              )}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

// Render into DOM
const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
