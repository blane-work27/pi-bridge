---
name: jank
description: Fan work out to many gateway-model worker agents from a codemode script, then verify and combine their results. Use for broad reviews, audits, multi-file changes, and sweeps that one context cannot cover, or when the user asks for jank or an ultracode-style workflow.
---

# jank

You are the orchestrator. You plan, write codemode scripts that run workers, judge their results, and write the final answer. Workers are cheaper gateway models. They do the reading and the mechanical work.

## Tools

Call these from `codemode` scripts as `tools.<name>(args)`. They return objects.

- `jank_worker({prompt, label?, model?, schema?, tools?, isolation?, base?, link?, cwd?, timeout_s?})` runs one worker. It returns `{ok, label, model, text, data?, error?, attempts, duration_ms, tool_calls, usage}`. With `isolation: "worktree"` it also returns `{base, patch, diffstat, files}`.
  - `prompt` is the whole task. The worker has no memory of this conversation. Give it the paths, the scope, the definition of done, and what to return.
  - `schema` is a JSON Schema. The worker must submit data that matches it, and you get it as `data`. Use a schema whenever a later step reads the result.
  - `tools` defaults to `read, grep, find, ls`. Add `jank_fetch` for web pages. Add `bash` only when the task must run commands.
  - At most 4 workers run at once. More calls queue. A failed worker returns `ok: false`. It does not throw.
- `jank_snapshot({})` returns `{base}`, a snapshot of the working tree. It changes no branch, index, or stash.
- `jank_merge({patches})` combines patches in a separate worktree. It returns `{combined, stat}`, or `{conflicts, integration}` when patches conflict.
- `jank_merge({integration})` finishes a merge after a worker resolved the conflicts in `integration`.
- `jank_apply({patch})` applies a patch to the user's tree as unstaged changes. It changes nothing if the patch does not apply.

## Worker models

| Model | Use |
|---|---|
| `icr-gpt56-luna/gpt-5.6-luna` | Default. Fast, reliable structured output. |
| `icr-gpt56-terra/gpt-5.6-terra` | Harder tasks, verifiers, judges. |
| `icr-gemini-4-argon/gemini-4-argon` | A second model family for verify panels, so a check does not share GPT's blind spots. Also inputs too large for the others (1M-token context). Slow, about 5 s per call, so do not use it for finders or bulk work. |

Use only these three models for workers.

## Rules

1. Scout first in your own context: list the files, read the diff, find the scope. Then write the script over a concrete work list.
2. Keep each codemode script under 25 minutes. A longer script loses this conversation's live connection. Run large work as several scripts, one per phase, and read each result before you write the next.
3. Use `Promise.all` over work items, and chain the stages of one item inside its own async function. Do not wait for every item to finish a stage before the next stage starts, unless the next stage needs all results together (for example, deduplication).
4. Return compact results from scripts. Filter and summarize in the script, so only what you need reaches your context.
5. Say what you dropped. If a script caps coverage (top N, no retry), print what it skipped.
6. You make the judgment calls. Workers find and check; you decide what is true and what to change.
7. Workers never commit. You never commit. Apply patches with `jank_apply` only after you checked the combined diff, then tell the user what changed.

## Patterns

Fan out and verify. Each finding gets three skeptics on three models. Keep it when at least two do not refute it.

```js
const FINDINGS = {type:"object", properties:{findings:{type:"array", items:{type:"object", properties:{file:{type:"string"}, line:{type:"number"}, claim:{type:"string"}, evidence:{type:"string"}}, required:["file","line","claim","evidence"]}}}, required:["findings"]};
const VERDICT = {type:"object", properties:{refuted:{type:"boolean"}, reason:{type:"string"}}, required:["refuted","reason"]};
const SKEPTICS = ["icr-gpt56-terra/gpt-5.6-terra", "icr-gpt56-luna/gpt-5.6-luna", "icr-gemini-4-argon/gemini-4-argon"];
const areas = ["src/auth", "src/billing", "src/api"];
const per = await Promise.all(areas.map(async (area) => {
  const f = await tools.jank_worker({ label: `find-${area}`, prompt: `Find real bugs in ${area}. Read the code. Report only bugs you can point to with a file and line.`, schema: FINDINGS });
  if (!f.ok) return { area, error: f.error, kept: [] };
  const judged = await Promise.all(f.data.findings.map(async (x) => {
    const votes = await Promise.all(SKEPTICS.map((m, i) => tools.jank_worker({ label: `verify-${area}-${i}`, model: m, schema: VERDICT,
      prompt: `Try to refute this claim. Read ${x.file} around line ${x.line}. If you are not sure it is a real bug, set refuted true.\nClaim: ${x.claim}\nEvidence: ${x.evidence}` })));
    const kept = votes.filter(v => v.ok && !v.data.refuted).length >= 2;
    return { ...x, kept, reasons: votes.map(v => v.ok ? v.data.reason : v.error) };
  }));
  return { area, kept: judged.filter(j => j.kept), refuted: judged.filter(j => !j.kept).length };
}));
return per;
```

Completeness critic. After a sweep, ask one strong worker what is missing. Its answer becomes the next round. Stop after two rounds that find nothing new.

```js
const CRITIC = {type:"object", properties:{gaps:{type:"array", items:{type:"string"}}}, required:["gaps"]};
const c = await tools.jank_worker({ label: "critic", model: "icr-gpt56-terra/gpt-5.6-terra", schema: CRITIC,
  prompt: `Task: ${TASK}\nCovered so far:\n${covered.join("\n")}\nList areas, files, or claims that were not checked. Return an empty list if nothing is missing.` });
```

Parallel edits. Every editing worker gets its own worktree from one snapshot. Merge the patches, then review the combined diff before you apply it.

```js
const { base } = await tools.jank_snapshot({});
const edits = await Promise.all(files.map(f => tools.jank_worker({ label: f, isolation: "worktree", base, link: ["node_modules"],
  prompt: `In ${f}, replace every call to oldApi() with newApi(). Change nothing else.` })));
const patches = edits.filter(e => e.ok && e.patch).map(e => e.patch);
const m = await tools.jank_merge({ patches });
return { failed: edits.filter(e => !e.ok).map(e => [e.label, e.error]), merge: m };
```

If `jank_merge` reports conflicts, give `integration` to a worker with `isolation: "none"`, `cwd: integration`, and the `edit` tool, then call `jank_merge({integration})`. Read the combined patch file, then call `jank_apply({patch: combined})`.

Workers that run tests or builds need the ignored directories they depend on in `link`. Tell those workers not to install packages, because linked directories are shared with the user's tree.
