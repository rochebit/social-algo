# Guideline: Document Structure & Cross-Referencing

This document details how specification files must be organized, named, and linked to maintain high clarity and readability.

---

## 1. Directory Structure

Specifications must be broken down logically to avoid monolithic, hard-to-read documents. 

A standard structure for system specifications should resemble the following:

```text
spec/
├── README.md                           # Main workspace index
├── .agents/
│   └── AGENTS.md                       # Project rules for AI agents
├── guidelines/
│   ├── philosophy.md                   # Spec philosophy
│   ├── behavior.md                     # Questioning & assumption rules
│   └── document_structure.md           # This file
├── architecture.md                     # High-level architecture & diagrams
├── api/                                # Folder for API endpoints
│   ├── authentication.md               # Auth-related endpoints spec
│   └── feed.md                         # Feed-related endpoints spec
├── data_models/                        # Folder for databases & data schemas
│   ├── schema.sql                      # SQL Table definitions (spec form)
│   └── lexicons/                       # AT Protocol custom lexicon files (.json)
└── workflows/                          # Folder for sequence flows
    └── post_creation_flow.md           # Workflow detail
```

*Create subdirectories whenever a single topic starts requiring multiple files.*

---

## 2. Cross-Referencing Files (Clickable Links)

To make it easy for implementing agents to navigate the specification, **every reference to another file or directory must be a clickable link.**

### Absolute File Scheme
Always use standard Markdown links with the absolute `file:///` scheme.
* Use **forward slashes** (`/`) for paths (even on Windows).
* Avoid backslashes (`\`) as they will break rendering for many markdown readers.

### Examples

* **Link to a file:**
  `[Architecture Diagram](file:///c:/Users/roche/Projects/social/atproto/spec/architecture.md)`
* **Link to a directory:**
  `[Lexicons Folder](file:///c:/Users/roche/Projects/social/atproto/spec/data_models/lexicons)`
* **Link to a specific line range:**
  `[PDS Schema](file:///c:/Users/roche/Projects/social/atproto/spec/data_models/schema.sql#L10-L25)`

---

## 3. Formatting Standards

Ensure all documents are clean and readable by adhering to the following style rules:

* **Short Paragraphs:** Keep sentences and paragraphs short. Bullet points are preferred over wall-of-text explanations.
* **Mermaid Diagrams:** Use Mermaid fenced code blocks (` ```mermaid `) to draw system architectures, state transitions, or database schemas. Quote node labels containing brackets or parentheses to avoid rendering syntax errors.
* **Semantic Headers:** Use a single `#` header per file, followed by `##` for sections and `###` for sub-sections.
* **Code Blocks:** Use syntax highlighting for code blocks (e.g., ` ```sql `, ` ```json `, ` ```typescript `) when showing schemas, responses, or configurations.
