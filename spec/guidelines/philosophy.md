# Guideline: Specification Philosophy & Completeness

This document defines the core philosophy of this workspace and details the standard of "completeness" required for all specifications written here.

---

## 1. Specification-Driven Development (SDD)

In this workspace, we practice **Specification-Driven Development (SDD)**. Under this paradigm, system design is entirely decoupled from code implementation. 

### Why Decouple?
1. **Separation of Concerns:** Design decisions (schemas, protocols, business rules) are resolved and documented without being clouded by implementation details (syntax, imports, framework boilerplate).
2. **AI Clarity:** AI agents are highly effective at implementing well-defined specifications, but are prone to hallucinations, shortcuts, and architectural drift when asked to design and code simultaneously.
3. **Reproducibility:** A perfect spec ensures that the implementation is predictable, testable, and robust.

---

## 2. The Completeness Test

The ultimate measure of a specification's quality is the **Completeness Test**:

> **"A specification is complete if and only if two independent AI agents, given this specification, would implement functionally identical systems."**

### Meaning of "Functionally Identical"
While the underlying syntax, variable names, or minor formatting of the code may differ, the following aspects must be identical:
* **API Surface:** Every route path, HTTP method, query parameter, headers, request body schema, response body schema, error response code, and payload structure.
* **Data Persistence:** Every database table, column name, data type, key constraint, index, and relational mapping.
* **Business Logic & Rules:** All algorithm choices, data validation limits (e.g., character length, regex patterns), auth policies, and state transitions.
* **Error Handling & Edge Cases:** Exact behavior when inputs are null, malformed, unauthorized, or when system dependencies fail.
* **Verification Scenarios:** The exact test coverage and assertions required.

---

## 3. Anti-Patterns (What to Avoid)

When writing specifications, avoid these common pitfalls:

| Anti-Pattern | Example | Correct Alternative |
|---|---|---|
| **Handwaving / Vague Instructions** | *"Implement appropriate validation on the username."* | *"The username must be a lowercase string matching `^[a-z0-9-]{3,15}$`. It cannot contain consecutive hyphens."* |
| **Delegating Design to the Coder** | *"Design a database schema to store posts and likes."* | *Define the exact SQL table creation script or Lexicon schemas, specifying columns, types, primary/foreign keys, and indexes.* |
| **Placeholders and TBDs** | *"Add other metadata fields here as needed."* | *List the exact metadata fields, their data types, and default values. If they are optional, state so explicitly.* |
| **Imprecise Error Handling** | *"Return an error if authentication fails."* | *"If the `Authorization` header is missing or invalid, return HTTP `401 Unauthorized` with body `{"error": "AuthenticationRequired", "message": "Valid bearer token is required."}`."* |
