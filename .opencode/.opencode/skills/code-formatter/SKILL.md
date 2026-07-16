---
name: code-formatter
description: Formats and validates GameNight Bingo TypeScript changes with the repository's Bun quality commands. Use before commits or after broad edits.
---

# Code Formatter

## Workflow

1. Read root `AGENTS.md` and inspect the available root scripts before running
   commands. Do not add quality tooling ahead of its dependency-ordered story.
2. Format changed files only through a configured repository script. If no
   formatter script exists yet, report formatting as unavailable rather than
   downloading or invoking unconfigured tooling.
3. Run the repository checks that exist:

   ```sh
   bun run typecheck
   bun run lint
   bun run format:check
   bun run test
   ```

4. Use `bun run test`, which invokes Vitest. Never substitute `bun test`,
   because that selects Bun's built-in test runner.
5. Fix only issues related to the current story. Do not rewrite unrelated user
   changes or bypass hooks and safeguards.
6. Inspect the final diff for accidental formatting churn before staging.

## Project Rules

- Treat root `AGENTS.md` as the implementation and validation authority.
- Use repository scripts rather than inventing one-off CI command variants.
- Record unavailable checks honestly until their planned tooling story lands.
