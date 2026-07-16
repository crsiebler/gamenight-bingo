---
name: git-manager
description: Prepares focused GameNight Bingo commits and pull requests without rewriting history. Use after implementation and validation are complete.
---

# Git Manager

## Workflow

1. Read root `AGENTS.md` and any task-specific Git instructions.
2. Confirm the current branch is the intended worktree branch. Do not create,
   switch, or repair branches when an automation workflow provides one.
3. Inspect before staging:

   ```sh
   git status --short
   git diff
   git log --oneline -10
   ```

4. Run all available Bun typecheck, lint, formatting, and Vitest commands
   required by root `AGENTS.md`.
5. Stage only files for the current story. Preserve unrelated user changes and
   inspect `git diff --cached` before committing.
6. Use `<type>(<scope>): <description>` unless the active authorized workflow
   requires an exact commit message.
7. Commit only after checks and required review pass. Never skip hooks, amend,
   rebase shared history, or force-push.
8. Push or create a pull request only when explicitly requested. Never push
   directly to a protected branch.

## Safety

- Never commit secrets, local environment files, database contents, captured
  user data, cookies, realtime tickets, or future draw positions.
- Never use destructive reset or checkout commands to remove changes you did
  not make.
- Do not merge a pull request or delete a branch without explicit direction.
