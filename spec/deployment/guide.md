# Deployment Guide Specification

This document details the configuration files, environmental variables, process management, and steps required to deploy the hybrid AT Protocol Feed Monitor.

---

## 1. Firebase Cloud Setup & Deployment

The web dashboard is hosted on Firebase, and reads/writes to Firestore. The following steps and files specify its deployment.

### 1.1 Project Initialization
1. Create a project in the [Firebase Console](https://console.firebase.google.com/).
2. Enable **Firebase Authentication** and turn on **Google Sign-In**. Add the whitelisted Google email to your security checks.
3. Enable **Cloud Firestore** in Production Mode.

### 1.2 Firebase Configuration Files
To deploy, the client repository must contain a `firebase.json` configuration file in the project root:

#### `firebase.json`
```json
{
  "firestore": {
    "rules": "firestore.rules",
    "indexes": "firestore.indexes.json"
  },
  "hosting": {
    "public": "dist",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**"
    ],
    "rewrites": [
      {
        "source": "**",
        "destination": "/index.html"
      }
    ],
    "headers": [
      {
        "source": "/client-metadata.json",
        "headers": [
          {
            "key": "Content-Type",
            "value": "application/json"
          },
          {
            "key": "Access-Control-Allow-Origin",
            "value": "*"
          }
        ]
      }
    ]
  }
}
```

#### `firestore.indexes.json`
Specifies the exact composite indexes required by the dashboard:
```json
{
  "indexes": [
    {
      "collectionGroup": "posts",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "isDeleted", "order": "ASCENDING" },
        { "fieldPath": "feedback", "order": "ASCENDING" },
        { "fieldPath": "matchedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "posts",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "feedback", "order": "ASCENDING" },
        { "fieldPath": "matchedAt", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

### 1.3 Firebase CLI Deployment Commands
1. Install Firebase CLI locally: `npm install -g firebase-tools`
2. Authenticate: `firebase login`
3. Link the local codebase to your project: `firebase use {firebase-project-id}`
4. Build the SPA client (produces the static folder `dist/`).
5. Deploy rules and indexes:
   `firebase deploy --only firestore`
6. Deploy the web app assets:
   `firebase deploy --only hosting`

### 1.4 PWA Deployment Assets
The frontend build pipeline (producing the target `dist/` static files folder) must bundle and place the following files in the root of the output directory:
- `manifest.json` (containing app names and stand-alone window rules).
- `sw.js` (the service worker logic for browser registration).
- `/icons/icon-192.png` and `/icons/icon-512.png` (PWA launcher icons).
These files will be served at the domain root (e.g. `https://social.rochebit.net/manifest.json`) to allow mobile browsers to detect and trigger the PWA installation prompt.

---

## 2. Home Server Daemon Deployment

The local ingestion daemon must run continuously and automatically restart if it crashes or if the server reboot occurs.

### 2.1 Firebase Service Account Credentials
To authorize the home server to write to Firestore:
1. In the Google Cloud Console, navigate to **IAM & Admin > Service Accounts**.
2. Select your Firebase project and create a new Service Account named `feed-monitor-daemon`.
3. Grant the role **Cloud Datastore User** (which covers Firestore read/write access).
4. Generate a new key in **JSON** format.
5. Save this key file as `firebase-credentials.json` on the home server.

### 2.2 Environment Variables Configuration (`.env`)
Create a `.env` file in the daemon directory on the home server:
```env
# AI Classification Configuration
AI_FILTERING_ENABLED=true
GEMINI_API_KEY=your_gemini_api_key_here

# Firebase Configuration
FIREBASE_PROJECT_ID=your_firebase_project_id_here
GOOGLE_APPLICATION_CREDENTIALS=/app/firebase-credentials.json
```

### 2.3 Containerized Process Management (Docker Compose)
We specify a Docker container deployment to encapsulate runtime environments and guarantee zero-downtime restarts.

#### `compose.yaml`
```yaml
services:
  feed-monitor-daemon:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: feed-monitor-daemon
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      # Mount the Service Account JSON credentials
      - ./firebase-credentials.json:/app/firebase-credentials.json:ro
      # Mount a local directory to persist cursor sequence numbers and logs
      - ./data:/app/data:rw
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

#### `data/` Volume Directory Contents
The mounted `./data` volume must persist the following runtime assets:
- `data/cursor.json`: Persists the last Jetstream sequence cursor.
- `data/curated_devs.json`: The list of whitelisted developer DIDs.
- `data/feedback_archive.jsonl`: The daily exported thumbs up/down rated post log.
