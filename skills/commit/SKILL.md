---
name: commit
description: Review the changes, write a commit message with the user, and commit. Push only when the user asks. Use when the user asks to commit, write a commit message, or push.
---

# commit

You commit only through the `git_commit` tool and push only through the `git_push` tool. `git commit` and `git push` in `bash` are blocked. Both tools ask the user to confirm in a dialog, set the author from the user's global name and the email for the remote's host, and refuse messages with AI attribution.

## 1. Review

1. Run `git status`, `git diff --staged`, and `git diff`. For untracked files, read the ones that look like they belong in this commit.
2. Run `git log --format='%s%n%b' -10` to see how this repository writes messages.
3. Tell the user what you found, briefly:
   - What the changes do, grouped by purpose.
   - Problems: debug output, commented-out code, secrets or keys, files that do not belong (build output, local config, `.env`), and unrelated changes that should be a separate commit.
   - What you propose to stage, if nothing is staged or the staged set looks wrong.

## 2. Ask

Ask the user the questions you cannot answer from the diff. Usually there are one to three:

- Why they made the change, if the diff does not show it.
- Whether to split unrelated changes into separate commits.
- Whether a fix closes an issue or ticket, and its ID.

Wait for the answers.

## 3. Draft

1. Stage the files the user agreed to, with `git add -- <paths>`. Do not stage anything else.
2. Write the message in the style of this repository's recent messages: the same tense, capitalization, and prefixes. If there is no clear style, use a short imperative subject line under 72 characters, a blank line, and a body only when the reason for the change is not obvious from the subject.
3. Write as the user. The message describes the change, not how it was made.
4. Never add `Co-authored-by` or other trailers, "Generated with" lines, emoji, or any mention of an AI, an agent, Claude, or this tool. `git_commit` refuses such messages.
5. Show the user the message and the staged file list. Ask for changes, and revise until they approve.

## 4. Commit

Call `git_commit({message})` with the approved message. The user confirms again in the dialog. If the tool refuses, tell the user why. Do not try to commit another way.

## 5. Push

Push only when the user asks you to in this conversation. Call `git_push({})`. It checks every outgoing commit's author, committer, and message before it pushes, and it never forces. If it refuses, tell the user the reason and stop. Do not rewrite commits to make a push pass unless the user asks for that.
