---
name: jank-research
description: Start a background research run that answers one factual question from primary sources and writes a cited Markdown file. Use when a grilling or design session needs an external fact (how a library, API, spec, or tool behaves), or when the user asks to research something without stopping the current conversation.
---

# jank-research

`jank_research` starts a separate orchestrator in the background and returns at once. That orchestrator uses gateway-model workers to read primary sources, verifies each claim, and writes one Markdown file. You get a message with the answer and the file path when it finishes.

## When a grilling session needs a fact

The grilling skill says that finding facts is your job and that you dispatch a sub-agent with a fresh context window. In this setup, `jank_research` is that sub-agent for facts outside the repository. For facts inside the repository, read the code yourself.

1. Write one narrow question that has a checkable answer. "Does library X retry on HTTP 429, and is it configurable in version 4?" is good. "Research library X" is too broad.
2. Write the brief. Do not paste the conversation. The researcher must not see your recommended answers or the user's preferences, because they bias what it looks for. The brief has:
   - Why the answer matters, and which decision it unblocks.
   - What answer would change that decision.
   - Facts that are already settled, with their sources (versions, stack, platform).
   - Paths in the repository the researcher may read, such as `GLOSSARY.md`, ADRs, or the code that uses the library.
3. Call `jank_research({question, brief})`.
4. Tell the user in one line that the research is running and which question waits for it.
5. Continue the round with the questions that do not depend on the answer. The question that waits for the research belongs to a later round.

## When the result arrives

A `jank-research` message arrives with the answer and the file path.

1. Read the file. Check that its claims carry links, and that the links point at primary sources.
2. Treat the answer as a settled fact for the waiting question, and cite the file when you use it.
3. If the file reports unverified or conflicting claims that matter for the decision, say so to the user and put the decision to them with that uncertainty.
4. Put the waiting question in the next round.

Use `jank_research_status` to check a run that seems slow. A run takes about 5 to 20 minutes.

## Output location

The file goes to `~/.local/state/jank/research/<repo>/` by default, outside git. Pass `out_dir` only when the repository already has a folder for research notes and the user wants the file there.
