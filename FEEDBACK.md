# Feedback — Neo4j Mini Agentic Hack

Project: **Collective Diary** — a graph-backed reflection engine, built as a standalone experiment for [Agent Diary](https://github.com/lr1ke/agent-diary) (submitted to a previous hackathon). Used: **Neo4j Aura Free**, plain Cypher, no APOC.

## What worked

- **Aura Free setup was genuinely fast** — instance up, credentials downloaded, connected from `neo4j-driver` in under 5 minutes. No friction worth mentioning.
- **The schema stayed tiny and still answered every question in the brief.** 4 node labels, 3 relationship types (`Agent`→`Session`→`TaskType`, `Session`→`Tool`) were enough for all six target reflection questions — individual and collective. Didn't need a `Strategy` node, a `FailureCategory` taxonomy, or a chronological session-chain; all of that turned out to be *queryable* from the base shape instead of needing to be modeled.
- **`ORDER BY` immediately before `collect()`** is enough to get sorted lists/chronological traces without APOC — useful to know for anyone avoiding the APOC dependency on Aura Free.
- **Cross-agent pattern queries are where the graph actually earns its keep.** The equivalent of Q4/Q5/Q6 (patterns shared across agents, peer comparison, transferable strategies) would be genuinely painful over flat Postgres rows — here it's a few lines of Cypher because `Tool` and `TaskType` are shared hub nodes every agent's sessions connect through.
- **Grounding the LLM narration strictly in query output** (never raw session data, never the answer key) worked better than expected — spot-checked the generated first-person reflections against the underlying evidence tables and every number/tool name traced back correctly, including a couple of cases where the model correctly *combined* two separate evidence tables to produce a derived number (e.g. "1 out of 10" from combining a rate in one table with a count in another). That wasn't something we prompted for explicitly.

## What worked (Aura MCP)

- Registering via `claude mcp add --transport http` + `claude mcp login` worked exactly as documented, and the OAuth flow was smooth once run from an actual interactive terminal (it fails — correctly, with a clear message — if attempted from a non-interactive/background shell, which is worth knowing going in).
- `get-schema` and `read-cypher` both round-tripped correctly against a live Aura Free instance, and freehand Cypher written fresh (not copied from existing scripts) correctly rediscovered patterns we'd already verified independently — good evidence the MCP path is demo-reliable, not just a toy.
- One practical note for anyone using Claude Code specifically: MCP servers register scoped to a project directory, and a session that's already running won't pick up a newly-added server — you need a fresh session started in that directory. Not a bug, just worth knowing before you're mid-demo assuming your current session has the tools.

## What was confusing

- **A chained relationship pattern that references a path shape which doesn't exist in your schema fails silently — zero rows, no error.** We wrote `(:TaskType)-[:USED_TOOL]->(Tool)` (should have been anchored on `Session`, not `TaskType`) and Cypher just returned nothing, no warning that the pattern couldn't possibly match anything given the schema. Coming from SQL, we expected something closer to a foreign-key/type error. This cost real debugging time and would be an easy trap for anyone modeling their first non-trivial multi-hop query.
- **Binary "does this relationship exist at all" is a bad default for behavioral comparison queries**, and it's not obvious until you hit it — one incidental/noisy edge is enough to make two very different usage patterns look identical under existence-only matching. Rate-based comparison (fraction of sessions touching a tool) was the fix, but this felt like a modeling gotcha specific to "compare behavior across entities" query patterns, worth calling out for other participants doing anything peer-comparison-shaped.
- Both of the above only surfaced by running against **real loaded data with a known-answer dataset**, not by reasoning about the Cypher on paper — worth flagging as a general lesson: build the verification/ground-truth step early, don't treat it as optional polish.
- **`Agent.id` vs `Agent.name` casing trap, surfaced via Aura MCP specifically.** Our loader keys `id` lowercase and `name` capitalized (normal — one's a machine key, one's a display label), but a freehand Cypher query filtering on `{name: 'nova'}` returns zero rows with no error at all. Completely reasonable modeling choice on our end, but the *failure mode* — silent empty result, not an error — is the same silent-failure trap as the relationship-chaining issue above. Feels like a recurring theme with Cypher: mismatched patterns and mismatched property values both fail the same way (quietly), which is a bigger gap for newcomers than any single instance of it.

## What blocked us

- Nothing blocked completion of the MVP end-to-end (synthetic data → load → 6 queries → grounded narration, individual + collective, all live-tested against Aura). The two issues above were caught and fixed within the session, not left open.
- Got to Aura MCP within the time available after all — confirmed live/interactive querying works end-to-end (see above). What we didn't get to: wrapping the six reflection queries themselves as named MCP tools (rather than freehand Cypher) so an agent could reliably call `individual_reflection(agentId)` instead of writing Cypher from scratch each time. That's the natural next step if there's a round 2.
