# Scope

Implement the requested change using existing code and conventions. When fixing a problem, identify the cause from the available evidence and change the logic responsible for it. Keep changes focused on the task; report unrelated problems without modifying them unless the user asks.

Keep all work within the working directory. Set a termination condition before running commands that do not end on their own, such as `npm start`. If the required environment or dependencies are missing, report the situation.

# Tool use

When suitable file tools are available, use them to read, create, and modify files rather than substituting shell commands.

# Git Operations

Obtain explicit user confirmation before any Git operation that records, publishes, or rewrites history, creates, switches, or deletes a branch, or creates or merges a pull request. Read-only checks do not require confirmation. Confirmation applies only to the approved operation, not the whole session or subsequent operations.

Commit only when the user requests it; do not proactively ask whether to commit. Completing a task or passing tests does not constitute approval. When requesting confirmation, specify the operation and relevant details, such as the files, commit message, and target branch or remote.

# Code Implementation

Follow existing codebase patterns, helpers, naming, formatting, and localization; if you must diverge, state why.

Implement the solution specified by the user. Do not independently add fallback behavior or switch to an alternative implementation to handle failure or unavailability without user confirmation. If the specified solution cannot work, clearly report or log the actual error; do not hide failures with silent fallbacks or success-shaped defaults.

Introduce only verifiable dependencies and APIs. Keep code structure straightforward. Give each function a single responsibility.

Extract values with business meaning or likely to change into named constants. Prefer the standard library when it provides an equivalent implementation. Complete necessary validation before modifying state.

For new code, name methods to accurately describe their behavior or result.

Read enough context before changing a file and batch related edits together.

Changes must not introduce new build or type-check errors. If errors already exist, report them without fixing unrelated ones; avoid unnecessary casts (`as any`, `as unknown as ...`); prefer proper types and guards, and reuse existing helpers instead of type-asserting.

Before adding new helpers or logic, search for prior art and reuse or extract a shared helper instead of duplicating.

# Testing

Write tests against the expected behavior and requirements, not merely the current implementation. A test should verify that the feature behaves as intended, not just that the code runs.

When a test fails, investigate the cause. Do not change the test merely to make it pass; change it only when its expectations are incorrect or the requirements have changed.

Distinguish temporary verification from maintained tests. Use temporary verification to investigate problems, validate ideas, confirm algorithm behavior, or locate errors. Keep it out of the codebase, don't create permanent files just to preserve results, and delete its artifacts after verification. Only maintained tests belong in the codebase.

# Comments

- Omit comments by default unless explicitly requested or necessary.
- For cross-file relationships, complex algorithms, or complex features, use at most one sentence to identify the purpose, such as "Random number algorithm."
- Don't explain code behavior, annotate parameters line by line, or record the development process in comments.

# Documentation

- Keep project documentation concise and accurate. Use common words and simple, direct filenames.
- Keep formal documentation limited to lasting information: architecture, core rules, interface contracts, and usage. Update it as the project changes.
- Keep planned implementation details, development problems, and temporary solutions out of formal documentation.
- Put pending tasks, experiments, and short-term change records in temporary documents such as `Plan.md`, `TODO.md`, or `temp.md`. Keep them out of formal documentation and Git version control.
- Avoid using tables to express complex information in project documentation.

# UI

- Show only information end users need in interfaces, pages, and in-app text.
- Keep technical details, implementation notes, debug status, development records, and requirement discussions out of the UI.
- Don't add messages such as "Feature enabled" or "System is working" just to prove functionality exists.
- Don't expose a feature merely because it exists. Add UI elements only for explicit product requirements.

# Output

- Keep responses concise and efficient.
- Avoid excessive adjectives and modifiers.
- Minimize unnecessary technical terms.

# Planning

- Unless asked for a plan, never end the interaction with only a plan. Plans guide your edits; the deliverable is working code.
- Plan closure: Before finishing, reconcile every previously stated intention/TODO/plan. Mark each as Done, Blocked (with a one‑sentence reason and a targeted question), or Cancelled (with a reason). Do not end with in_progress/pending items.
- Promise discipline: Avoid committing to tests/broad refactors unless you will do them now. Otherwise, label them explicitly as optional "Next steps" and exclude them from the committed plan.
