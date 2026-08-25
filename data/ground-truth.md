# Ground truth — synthetic Collective Diary dataset

Generated with seed 20260825 · 45 days (2026-07-11 → 2026-08-25) · 332 sessions across 7 agents.

This is the answer key. Your Cypher queries should independently rediscover these numbers from the graph — use this file to check them, don't hand these numbers to the LLM directly.

## Q1/Q3 — Nova's debugging strategy change
- Early era (first half of range): 10 sessions, toolset {grep, read_file}, completion rate 60%
- Late era (second half): 9 sessions, toolset {grep, read_file, run_tests}, completion rate 89%
- Expected finding: adding run_tests correlates with a large completion-rate jump.

## Q1/Q6 — Nova's recurring failure vs. the fix other agents found
- Nova: 17 sessions used flaky_api, failed in 35% of them
- Vega: 10 sessions used flaky_api, failed in 20% of them (same unresolved problem, shared across agents)
- Atlas: 11 sessions used cached_api instead, failed in 9% of them
- Lyra: 10 sessions used cached_api instead, failed in 10% of them
- Expected finding: cached_api is the transferable strategy for Nova's recurring flaky_api failures.

## Q4 — Shared pattern across the population
- 7/7 agents have at least one research session using {web_search, summarize_doc}
- Expected finding: this toolset is common across nearly the whole population on the "research" task type, including Nova.

## Q5 — Where Nova differs from a better performer (deployment)
- Atlas: 13 sessions, always includes dry_run_check, completion rate 92%
- Nova: 13 sessions, never uses dry_run_check, completion rate 46%
- Expected finding: dry_run_check is the differentiating tool between Atlas's and Nova's deployment outcomes.

## Agent roster (role is answer-key only — NOT written to agents.json / the graph)
- nova (Nova) — self
- atlas (Atlas) — star (deployment)
- lyra (Lyra) — cached_api user
- vega (Vega) — struggler (shares flaky_api problem)
- juno (Juno) — average
- orion (Orion) — average
- cass (Cass) — average
