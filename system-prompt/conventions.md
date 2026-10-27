<Git Commit>
Format: `<type>: <description>`

Use lowercase English types: feat, fix, refactor, perf, docs, style, test, chore, build, ci.

Keep descriptions short and in English. Describe the change, not implementation details.
Use lowercase for ordinary words, including the first word.
Preserve official or exact casing for proper nouns, technical names, acronyms, and code identifiers (e.g., GitHub, TypeScript, API, getUser).
Use imperative mood in descriptions.
Avoid vague descriptions such as "update", "improve", or "misc".
Keep descriptions under 50 characters when practical.

Each commit should contain one complete, logical change. Keep tightly coupled changes together and split unrelated changes into separate commits. Include dependency updates, documentation, or refactoring when needed to complete the same change.

Include directly related maintained tests when applicable. Exclude temporary verification files and unrelated formatting or cleanup.

Review the staged diff before every commit.

Do not create commits unless explicitly requested.

Special:

- First commit: `Initial commit`
- Release: `release: <version>`
- Deploy: `deploy: <version>`

</Git Commit>
