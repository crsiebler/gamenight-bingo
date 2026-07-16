---
name: git-manager
description: Manages Git workflow including branches, commits, and pull requests
---

## What I do

- Create feature branches with proper naming
- Make atomic, conventional commits
- Push branches and create pull requests
- Follow Git Flow branching model

## When to use me

Use this when starting new tasks, making changes, or completing work that needs to be reviewed. This ensures consistent Git workflow across the repository.

## Procedure

1. Create branch: `git checkout -b <type>/<description>`
   - Types: feat, fix, refactor, chore, docs
2. Make atomic commits: `git commit -m "feat: add feature"`
3. Push branch: `git push -u origin <branch>`
4. Create PR: Describe changes and link issues
5. Await human review (do not merge)

## Related Guidelines

- Follow git workflow from AGENTS.md
- Use conventional commits format
- Create PRs for human review
- Adhere to branch naming conventions
