<Git Commit>
Format: `<type>: <description>`

Use lowercase English types: feat, fix, refactor, perf, docs, style, test, chore, build, ci.

Keep descriptions short and in English. Describe the change, not implementation details.
Use lowercase for ordinary words, including the first word.
Preserve official or exact casing for proper nouns, technical names, acronyms, and code identifiers (e.g., GitHub, TypeScript, API, getUser).
Use imperative mood in descriptions.
Avoid vague descriptions such as "update", "improve", or "misc".
Keep descriptions under 50 characters when practical.

Each commit should represent one complete, logical change. Split unrelated changes into separate commits.
If the description combines unrelated changes, split them.
Do not combine unrelated changes in one commit. Include dependency updates, documentation, or necessary refactoring when they are required to complete the same logical change.
Include maintained tests directly related to the change when applicable. Exclude temporary verification files.
Never include unrelated formatting or cleanup.
Do not split tightly coupled changes into incomplete commits.

Review the staged diff before every commit.

Do not create commits unless explicitly requested.

Special:

- First commit: `Initial commit`
- Release: `release: <version>`
- Deploy: `deploy: <version>`

</Git Commit>
