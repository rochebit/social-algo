# Guideline: Agent Behavior & Questioning

This document outlines the strict behavioral standards for AI agents operating in this workspace regarding questioning, assumption tracking, and scope enforcement.

---

## 1. The Questioning Imperative

When you encounter ambiguity or missing details in the system requirements, **do not assume or fill in the blanks yourself.** You must ask the user.

### When to Ask Questions
* When the target database choice is unspecified.
* When error handling rules or response bodies are not detailed.
* When performance constraints or load requirements are vague.
* When UI/UX behavior or validation limits are undefined.
* When integration protocols (e.g., specific AT Protocol XRPC endpoints) are not selected.

### How to Ask Questions
1. **Be Structured:** Group questions logically.
2. **Be Actionable:** Provide 2-3 concrete options for the user to choose from.
3. **Provide Context:** Briefly explain the trade-offs of each option.
4. **Do Not Ask Too Many at Once:** Limit lists to 3-5 high-priority questions per turn to keep iteration focused and prevent user fatigue.

---

## 2. Assumption Management

If you must make an assumption to write a draft (e.g., when the user asks you to write a preliminary specification), you must follow this tracking protocol:

### The Assumption Format
Every assumption in the specification must be tagged inline with:
`[ASSUMPTION: <ID> - <Description>]`

Where:
* `<ID>` is a sequential number (e.g., `A001`, `A002`).
* `<Description>` is the exact detail assumed.

### The Assumptions log
At the end of every specification file (or in a dedicated `assumptions.md` file), you must maintain an **Assumptions Log** formatted as a markdown table:

| ID | Description | Status | Resolution / Date |
|---|---|---|---|
| A001 | Assumed Postgres is used as the relational database. | `[PENDING]` | - |
| A002 | Assumed session tokens expire after 24 hours. | `[CONFIRMED]` | Confirmed by User on 2026-07-01. |

### Resolving Assumptions
* You must prompt the user to resolve `[PENDING]` assumptions at the beginning of each turn.
* Once the user approves or rejects an assumption, update the log and update the specification text accordingly.
* **A specification cannot be marked complete if it contains any `[PENDING]` assumptions.**

---

## 3. Refusing Implementation Code

You must maintain a strict boundary between specification and implementation.

### Standard Refusal Template
If the user asks you to implement code, run code, or write script files in this workspace, respond with the following message:

> "I cannot implement or write application code in this folder, as this is a **Specification-Only Workspace** governed by the rules in [.agents/AGENTS.md](file:///c:/Users/roche/Projects/social/atproto/spec/.agents/AGENTS.md). 
> 
> However, I can write the complete, detailed markdown specifications for this feature so that you can pass it to an implementation agent in a different directory. Would you like me to draft the specification?"
