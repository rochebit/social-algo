import * as dotenv from "dotenv";
import * as path from "path";
import { initDb, hasFirstDegreeFollows, syncNetworkGraph } from "./db";
import { initFirestore, startArchiverScheduler, startOutboxWorker } from "./firestore";
import { startJetstream, startCursorPersistence } from "./jetstream";
import { startBatchWorker } from "./batch_worker";

// Load environment configurations
dotenv.config();

async function main() {
  console.log("=== Starting AT Protocol Developer Feed Monitor Daemon ===");

  const userDid = process.env.USER_DID;
  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
  const aiEnabled = process.env.AI_FILTERING_ENABLED !== "false";
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!firebaseProjectId) {
    console.warn("WARNING: FIREBASE_PROJECT_ID is not defined in the environment. Falling back to 'mock-project' for local emulator.");
  }

  if (aiEnabled && !geminiKey) {
    console.error("ERROR: AI_FILTERING_ENABLED is set to true, but GEMINI_API_KEY is missing. Disabling AI filtering and entering bypass mode.");
    process.env.AI_FILTERING_ENABLED = "false";
  }

  // 1. Initialize SQLite network graph DB
  console.log("Initializing local SQLite network graph database...");
  initDb();

  // 2. Startup Network Graph Sync
  if (!userDid) {
    console.warn("WARNING: USER_DID is not defined in the environment. Real-time follow graph synchronization and network-graph filtering bypass will be disabled.");
  } else {
    const hasFollows = hasFirstDegreeFollows();
    if (!hasFollows) {
      console.log("Database has no follows. Triggering full network graph sync...");
      try {
        await syncNetworkGraph(userDid);
      } catch (err) {
        console.error("Failed to perform initial social graph sync:", err);
        console.log("Daemon will continue starting up; graph will sync dynamically as follow events are detected.");
      }
    } else {
      console.log("Database contains existing follows. Skipping initial startup graph sync.");
    }
  }

  // 3. Initialize Firestore Client
  console.log("Initializing Firestore client...");
  initFirestore();

  // Start Outbox Sync Worker (retries queued writes in background)
  console.log("Starting outbox sync worker...");
  startOutboxWorker();

  // Start Batch Ingestion relevance evaluation worker
  console.log("Starting batch evaluation worker...");
  startBatchWorker();

  // 4. Start Cursor State Persistence (every 5 seconds)
  console.log("Starting cursor persistence worker...");
  startCursorPersistence();

  // 5. Start Daily Archiver Scheduler (every 24 hours)
  console.log("Starting daily feedback log archiver...");
  startArchiverScheduler();

  // 6. Connect to ATProto Firehose (Jetstream)
  console.log("Connecting to Jetstream firehose consumer...");
  startJetstream(userDid || "did:plc:placeholder");

  console.log("Daemon successfully initialized and running.");
}

main().catch((err) => {
  console.error("Fatal daemon startup error:", err);
  process.exit(1);
});
