# Specification Workspace

Welcome to the **Specification Workspace** for the AT Protocol project. 

The sole purpose of this repository is to maintain, refine, and store system specifications and AI instruction files. **No implementation code is to be written in this folder.** 

Any system implementation will be performed by a separate AI agent or developer in a different workspace, using the files in this directory as their source of truth.

---

## Developer Feed Monitor Specifications

We are specifying a hybrid system to monitor the AT Protocol firehose for developer community content, filter it, and sync it to a Firestore database for consumption via a Firebase web UI with a feedback logging dashboard.

- 🏗️ **[System Architecture](file:///c:/Users/roche/Projects/social/atproto/spec/architecture.md):** High-level topology, data synchronization boundaries, and external application linking.
- 🗃️ **[Firestore Schema & Security](file:///c:/Users/roche/Projects/social/atproto/spec/data_models/firestore_schema.md):** Document formats, collections, required indexes, and Firebase Security Rules.
- ⚙️ **[Filtering Pipeline & Feedback](file:///c:/Users/roche/Projects/social/atproto/spec/workflows/filtering_pipeline.md):** Ingestion, rules, Gemini LLM classification prompt, bypassing options, and simple feedback tracking.
- 📱 **[Dashboard UI & Layout](file:///c:/Users/roche/Projects/social/atproto/spec/api/dashboard_ui.md):** Routing, authentication checks, post card visual hierarchy, and feedback updates.
- 🧪 **[Test & Verification Scenarios](file:///c:/Users/roche/Projects/social/atproto/spec/verification/test_scenarios.md):** Test scenarios for Firebase security rules, ingestion filtering mocks, and UI formatting links.
- 🚀 **[Deployment Guide](file:///c:/Users/roche/Projects/social/atproto/spec/deployment/guide.md):** CLI commands, Firebase configurations, environment variables, and Docker Compose processes.

---

## Core Guidelines

To ensure that specifications written here are flawless and ready for execution, all AI agents operating in this workspace must adhere to a strict set of behavioral rules:

1. **Spec-Only Constraint:** Do not write, generate, or scaffold application code here. Only write specifications and documentation in Markdown format.
2. **Ambiguity Elimination:** Specifications must be extremely detailed. The goal is to make the specification so complete that if it were given to two different agents, they would implement essentially the same code.
3. **No Unconfirmed Assumptions:** Do not make undocumented or unconfirmed assumptions. All assumptions must be recorded explicitly as open items to be confirmed by the user.
4. **Proactive Clarification:** Ask the user clarifying questions immediately when requirements are underspecified or ambiguous. Do not proceed with vague designs.
5. **Hierarchical Decomposition:** Work from high-level summaries down to highly granular component specifications across multiple files.

For full, detailed instructions, see the sub-documents in the [guidelines/](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines) directory:

- 📖 **[Core Philosophy & Completeness](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/philosophy.md):** The definition of a "complete spec" and why we separate specifications from implementation.
- 💬 **[Agent Behavior & Questioning](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/behavior.md):** Rules for asking questions, noting assumptions, and refusing to write code.
- 🗂️ **[Document Structure & Cross-Referencing](file:///c:/Users/roche/Projects/social/atproto/spec/guidelines/document_structure.md):** How specification files must be organized, named, and linked.

---

## Workspace Configuration

This workspace uses Antigravity project-scoped rules defined in [.agents/AGENTS.md](file:///c:/Users/roche/Projects/social/atproto/spec/.agents/AGENTS.md). These rules are automatically loaded by the AI agent upon starting a chat in this workspace to enforce the above guidelines.
