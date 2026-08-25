# Demo script — Collective Diary

A graph-backed reflection engine for [Agent Diary](https://github.com/lr1ke/agent-diary). Built standalone for the Neo4j Mini Agentic Hack. ~4 minutes.

Fallback: if Aura/network is unhappy live, `demo-transcript.txt` in this folder is a real captured run — read from that instead of losing the demo.

---

## 1. The problem (30s)

Agent Diary's real `/api/diary/reflect` endpoint (show `docs/agent-diary-api-spec.md` in `hack-my-agent` if handy) works like this: pull an agent's last N diary rows from Postgres, dump them as JSON into a Claude Haiku prompt, ask it to find patterns. That's LLM-only pattern-matching over flat rows — no relationships, so:

- it can't tell you what's shared across *other* agents (there's no concept of "other agents" at all — one query = one agent's rows)
- "recurring" or "trend" is whatever Claude eyeballs from a JSON blob, not something you can verify

The question: can a graph do this better — surface relationships an LLM would have to imagine from flat data?

## 2. The model (30s)

Show `schema.cypher` or the Mermaid diagram. Four node types, three relationships:

```
(Agent)-[:RAN]->(Session)-[:CLASSIFIED_AS]->(TaskType)
                    |
                    +-[:USED_TOOL {succeeded}]->(Tool)
```

Key point to say out loud: **nothing here is a precomputed pattern.** No "recurring failures" field, no "trend" field. `TaskType` and `Tool` are shared hub nodes — the same `Tool` node is touched by every agent that ever used it. That's the whole reason this beats the Postgres version: patterns *emerge* from traversal instead of being computed per-agent in isolation.

## 3. Live query walkthrough (2 min)

```bash
node run-reflection.mjs nova
```

Narrate over the output as it scrolls — don't wait for the end:

- **Q1 (recurring failures)** — point at `deploy_script: 6 failures`. Say: *"I didn't design the synthetic data around this specific number — I expected `flaky_api` to be the headline failure. The graph found something I didn't tell it to find."*
- **Q5 (peer comparison)** — point at `dry_run_check: I use it 8%, they use it 100%`. Say: *"This is the finding that matters. Not 'they use a tool I don't' — that's brittle, a single incidental use erases it. This is a usage-rate gap: Atlas runs it on every deployment, I run it on almost none."*
- **Q6 (transferable strategies)** — point at the alternatives table. Say: *"This is fed by Q1's own output — the graph found my top recurring failure, then went looking across the whole population for what else works on that exact task type."*
- **The narrated reflections at the bottom** — read 2-3 sentences from each (individual, then collective) out loud. Call out one specific number in the narration and trace it back to the evidence table above it, live, to prove it's not hallucinated: *"'1 dry_run_check session out of 10 deploy_script attempts' — that's not a number I gave the model directly. It combined the 8% rate from Q5 with the usage count from Q4 itself."*

## 4. The bugs, briefly (30s) — this is good material, don't skip it

Two real Cypher bugs turned up when I ran these against live data instead of just reasoning about them on paper:

- Chaining `(TaskType)-[:USED_TOOL]->(Tool)` silently matched **zero rows** — no error, just quietly wrong, because that relationship doesn't exist in the schema (`USED_TOOL` only goes from `Session`). Cypher doesn't warn you when a chained path references a shape that isn't there.
- Comparing "did I ever use this tool" (binary) instead of "what fraction of my sessions used this tool" (rate) erased a real, strong signal — one incidental noisy session was enough to make Atlas's 100%-of-the-time `dry_run_check` habit look identical to Nova's near-total avoidance of it.

Both only surfaced by executing against real data and eyeballing results against a known-answer synthetic dataset — reviewing the Cypher on paper wouldn't have caught either.

## 5. What's next (10s)

Aura MCP to make querying live/interactive instead of a canned script; wiring this in as the real replacement for `reflect.ts` in the production app once it's had more runway than a hackathon afternoon.

---

## Commands, if you want to run it live instead of narrating over a static transcript

```bash
cd ~/Desktop/tryNeo4j
node generate-synthetic-data.mjs   # regenerate the dataset (deterministic, same output every time)
node load-graph.mjs                # wipe + reload Aura, verify 5 patterns against ground-truth.md
node run-reflection.mjs nova       # run all 6 reflection queries + narrate individual/collective
node run-reflection.mjs atlas      # or any other agent — vega and lyra are also good picks
```
