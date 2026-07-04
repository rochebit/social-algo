# Workspace Rules: Specification-Only Agent Behavior

You are running inside a **Specification-Only Workspace** for the AT Protocol project. The primary goal of this workspace is to write, maintain, and iterate on system specifications. No application or implementation code is written here.

As an agent operating in this workspace, you must adhere to the following rules at all times.

---

## 🚫 1. No Code Implementation

* **Constraint:** Do not write, generate, edit, or scaffold application/implementation code (such as Go, TypeScript, Rust, Python, JavaScript, HTML, CSS, shell scripts, or Dockerfiles) in this workspace.
* **Exceptions:** You may write raw JSON/YAML schemas, Lexicon schemas, or OpenAPI specifications *if* they are part of a specification file. You may also write mock HTTP requests/responses for API documentation.
* **Refusal:** If the user asks you to write implementation code in this workspace, politely refuse and state that this is a specification-only repository. Explain that the code should be implemented in a separate workspace using the specs written here.

---

## ❓ 2. Aggressive Questioning & Clarification

* **Constraint:** Do not make assumptions about system design, protocol behavior, API structures, or database schemas.
* **Action:** When requirements are underspecified, vague, or open to interpretation, you **must stop** and ask the user clarifying questions.
* **Goal:** Keep asking questions and refining the documents until the specification is completely unambiguous (see [philosophy.md](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/philosophy.md) for completeness criteria).

---

## 📋 3. Explicit Assumption Tracking

* **Constraint:** If you must make an assumption to move forward (e.g., when the user is temporarily unavailable or asks you to make a draft), you **must** explicitly document it.
* **Action:** Tag all assumptions clearly in your output and in the relevant spec files as `[ASSUMPTION: <Description>]`. Maintain an "Open Assumptions" list in each document and verify them with the user at the earliest opportunity.

---

## 🗂️ 4. Hierarchical Spec Decomposition

* **Constraint:** Do not write massive, monolithic specification files.
* **Action:** Break down specs hierarchically:
  1. High-level README/Overview.
  2. Sub-component specifications (e.g., `api/`, `data_models/`, `auth/`).
  3. Granular endpoint or schema details.
* **Action:** Cross-reference all files using clickable markdown links (e.g., `[Auth Spec](file:///c:/Users/roche/Projects/social/atproto/spec/auth.md)`).

---

## 📖 5. Follow Spec Guidelines

You must read, understand, and apply the detailed guidelines stored in the `guidelines/` directory:
- **Core Philosophy:** [philosophy.md](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/philosophy.md)
- **Agent Behavior & Questioning:** [behavior.md](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/behavior.md)
- **Document Structure:** [document_structure.md](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/document_structure.md)
