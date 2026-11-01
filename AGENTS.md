# Repository instructions

These instructions apply to Codex and other agents throughout this repository.
This personal bot is an explicit exception to the global Zendesk Git/PR workflow.
The repository-specific rules below take precedence here.

<!-- Migrated from .cursor/rules/push-to-main-no-prs.mdc. -->

# Push to main — no PRs

This is a **personal live-draft bot**, not a Zendesk repo.

## Hard rules

- After implementation: commit on **`main`**, `git push origin main`, deploy Oracle.
- **Never** `gh pr create`, **never** draft PRs, **never** feature-branch-for-review.
- Do **not** follow `never-push-to-main.mdc`, `pr-draft-until-ready.mdc`, `pr-label-team-atlas.mdc`, or `rebase-before-pr.mdc` **in this repository**. Those are for Zendesk. This repo is the exception.
- Do **not** ask whether to use a PR. Push main.

## Allowed

```bash
git checkout main
git add …
git commit -m "…"
```

**Push as `tim95030`**, not `tschroeder-zendesk` (default `git push` / SSH often picks the work key):

Use the personal account’s configured Git credential helper or an isolated
GitHub CLI credential helper. Never put an access token in a remote URL, command
argument, log, or committed file.

Then on Oracle: verify the checkout is clean, fetch and fast-forward to
`origin/main`, register commands if their definitions changed, and restart
`fantasy-draft-bot`. Preserve live data and `.env`.

## Forbidden

```bash
git checkout -b tschroeder/…
gh pr create
gh pr create --draft
```

If you already opened a PR by mistake: merge it into `main` (or cherry-pick), push `main`, close the PR. Do not leave work sitting on a branch waiting for review.

<!-- Migrated from .cursor/rules/no-discord-deletes-without-confirmation.mdc. -->

# No Discord deletes without confirmation

This bot runs against a **live league Discord**. Deletions are irreversible (Discord does not restore message content).

## Hard rules

- **Never** delete (or run scripts that delete) Discord **threads**, **messages**, **channels**, or **reactions** unless the user explicitly asked to delete **that specific** item in the current conversation.
- **Never** batch-delete by name pattern (e.g. matching player names) without the user listing each target and confirming.
- **Before** any approved delete: **export** thread message history to a local file or paste a summary for the user when content might matter (auctions, bids, commish notes).
- Prefer **archive**, **lock**, or **registry fixes** over deletion when cleaning up permission or duplicate-thread issues.
- Do **not** interpret vague cues ("like perm-test-delete-me") as permission to delete similarly named **real** auction threads.

## Allowed without extra confirmation

- Read-only API calls (fetch channel, list threads, fetch messages, audit where permitted).
- Deleting **only** resources the user just created in the same message for testing (e.g. "delete the thread you just created named X") when **X** is unambiguous.

## If cleanup is needed

1. List candidates (name, id, created time, registry key).
2. Ask the user which ids to remove.
3. Dump messages, then delete only what they confirm.

## Validation

- Run `node --test src/transactions/*.test.js` for transaction changes.
- Use isolated mocks for Discord mutations and temporary directories for test state.
- Never connect a test bot or create live Discord transactions as a smoke test.
- Check the deployed version and service health after an authorized deployment.
