#!/usr/bin/env node
// generate-synthetic-data.mjs
//
// Synthetic multi-agent dataset for the "Collective Diary" graph-reflection
// MVP (Neo4j Mini Agentic Hack). Zero dependencies — plain Node ESM.
//
// Deterministic (seeded RNG) on purpose: a live demo shouldn't depend on
// random luck to surface the patterns the Cypher queries are supposed to
// find. This script plants specific, known answers for each of the six
// target reflection questions, then layers realistic background noise on
// top so the dataset doesn't look hand-crafted.
//
// Run:  node generate-synthetic-data.mjs
// Out:  data/sessions.json   — flat AgentSessionReport[] (+ taskType, sessionId), all agents
//       data/agents.json     — agent identity records (no answer-key fields)
//       data/ground-truth.md — cheat sheet of the ACTUAL realized patterns,
//                              computed from the generated data, so you can
//                              sanity-check your Cypher queries against it.

import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// ─── seeded RNG (mulberry32) — reproducible across runs ──────────────────

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEED = 20260825
const rand = mulberry32(SEED)

const pick = (arr) => arr[Math.floor(rand() * arr.length)]
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min
const chance = (p) => rand() < p
const subset = (arr, minN, maxN) => {
  const n = randInt(minN, Math.min(maxN, arr.length))
  const copy = [...arr]
  const out = []
  for (let i = 0; i < n; i++) out.push(copy.splice(randInt(0, copy.length - 1), 1)[0])
  return out
}
function pickWeighted(weightedMap) {
  const entries = Object.entries(weightedMap)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let r = rand() * total
  for (const [k, w] of entries) { r -= w; if (r <= 0) return k }
  return entries.at(-1)[0]
}

// ─── time range ────────────────────────────────────────────────────────

const DAYS = 45
const END_DATE = new Date('2026-08-25T00:00:00.000Z')
const START_DATE = new Date(END_DATE.getTime() - DAYS * 86_400_000)

// ─── vocabulary ────────────────────────────────────────────────────────

const TASK_TYPES = ['coding', 'debugging', 'data-extraction', 'analysis', 'research', 'deployment']

const TOOLS_BY_TASK_TYPE = {
  coding: ['write_file', 'read_file', 'execute_code', 'lint'],
  debugging: ['grep', 'read_file', 'run_tests', 'execute_code'],
  'data-extraction': ['database_query', 'api_call', 'flaky_api', 'cached_api'],
  analysis: ['database_query', 'summarize_doc', 'execute_code'],
  research: ['web_search', 'summarize_doc', 'vector_search'],
  deployment: ['deploy_script', 'shell_exec', 'lint', 'dry_run_check'],
}

const TASK_DESCRIPTIONS = {
  coding: [
    'Implement pagination for the entries endpoint',
    'Add retry logic to the tool executor',
    'Refactor the aggregator into pure functions',
    'Write the CSV export helper',
  ],
  debugging: [
    'Investigate intermittent 500s on /api/diary/entry',
    'Trace why token counts double-count on retries',
    'Fix flaky test in aggregator.test.ts',
    'Chase down a race condition in the upsert path',
  ],
  'data-extraction': [
    "Pull last week's session logs from the archive",
    'Extract tool call metadata from raw traces',
    'Backfill agentName for legacy rows',
    'Extract error payloads from failed runs',
  ],
  analysis: [
    "Summarize this week's workload distribution",
    'Compare completion rates across task types',
    'Identify which tools correlate with failures',
    'Review token spend per session',
  ],
  research: [
    'Look up best practices for x402 payment retries',
    'Research alternatives to the current vector store',
    'Survey how other agents log tool failures',
    'Investigate Neo4j Aura pricing tiers',
  ],
  deployment: [
    'Deploy the reflect endpoint to staging',
    'Roll out the new aggregator to production',
    'Push schema migration 003',
    'Promote the Aura MCP config to prod',
  ],
}

// role is answer-key metadata for the ground-truth report ONLY —
// it must never be written into agents.json / the graph.
const AGENTS = [
  { id: 'nova', name: 'Nova', modelId: 'claude-sonnet-4-5', frameworkName: 'anthropic', role: 'self' },
  { id: 'atlas', name: 'Atlas', modelId: 'claude-sonnet-4-5', frameworkName: 'anthropic', role: 'star (deployment)' },
  { id: 'lyra', name: 'Lyra', modelId: 'gpt-4o', frameworkName: 'openai', role: 'cached_api user' },
  { id: 'vega', name: 'Vega', modelId: 'claude-haiku-4-5', frameworkName: 'anthropic', role: 'struggler (shares flaky_api problem)' },
  { id: 'juno', name: 'Juno', modelId: 'gpt-4o-mini', frameworkName: 'openai', role: 'average' },
  { id: 'orion', name: 'Orion', modelId: 'claude-sonnet-4-5', frameworkName: 'anthropic', role: 'average' },
  { id: 'cass', name: 'Cass', modelId: 'gpt-4o', frameworkName: 'openai', role: 'average' },
]

const TASK_WEIGHTS_DEFAULT = { coding: 20, debugging: 15, 'data-extraction': 15, analysis: 15, research: 20, deployment: 15 }

// ─── session builder ───────────────────────────────────────────────────

const BASE_TOKENS = {
  coding: [6000, 2000],
  debugging: [5000, 1800],
  'data-extraction': [4000, 1200],
  analysis: [4500, 1500],
  research: [5500, 2200],
  deployment: [4000, 1300],
}

function toolUsage(toolName, failed) {
  const calls = randInt(1, 3)
  const failedCalls = failed ? randInt(1, calls) : 0
  return { toolName, calls, failedCalls }
}

function buildSession({ agentId, taskType, dayOffset, tools, failedTools = [], completed }) {
  const date = new Date(START_DATE.getTime() + dayOffset * 86_400_000)
  const start = new Date(date)
  start.setUTCHours(randInt(7, 21), randInt(0, 59), 0, 0)
  const durationMin = randInt(4, 35)
  const end = new Date(start.getTime() + durationMin * 60_000)

  const usages = tools.map((t) => toolUsage(t, failedTools.includes(t)))
  const toolCallsTotal = usages.reduce((s, u) => s + u.calls, 0)
  const toolCallsFailed = usages.reduce((s, u) => s + u.failedCalls, 0)

  const [baseIn, baseOut] = BASE_TOKENS[taskType]
  const scale = 0.6 + rand() * 0.8

  return {
    sessionId: randomUUID(),
    agentId,
    taskType,
    sessionStart: start.toISOString(),
    sessionEnd: end.toISOString(),
    tokenUsageInput: Math.round(baseIn * scale),
    tokenUsageOutput: Math.round(baseOut * scale),
    toolCallsTotal,
    toolCallsSucceeded: toolCallsTotal - toolCallsFailed,
    toolCallsFailed,
    uniqueToolsUsed: tools,
    failedToolNames: failedTools,
    taskDescription: pick(TASK_DESCRIPTIONS[taskType]),
    taskCompleted: completed,
  }
}

// ─── Phase A: engineered core — one block per target reflection question ──

const sessions = []

// Q2 / Q3 — Nova's debugging strategy visibly improves partway through.
// Early era: {grep, read_file} only, ~50% completion.
// Late era:  adds run_tests, ~90% completion.
const HALF = Math.floor(DAYS / 2)
for (let i = 0; i < 8; i++) {
  const completed = chance(0.5)
  sessions.push(buildSession({
    agentId: 'nova', taskType: 'debugging', dayOffset: randInt(0, HALF - 1),
    tools: ['grep', 'read_file'],
    failedTools: completed ? [] : (chance(0.5) ? ['read_file'] : []),
    completed,
  }))
}
for (let i = 0; i < 8; i++) {
  const completed = chance(0.9)
  sessions.push(buildSession({
    agentId: 'nova', taskType: 'debugging', dayOffset: randInt(HALF, DAYS - 1),
    tools: ['grep', 'read_file', 'run_tests'],
    failedTools: completed ? [] : ['run_tests'],
    completed,
  }))
}

// Q1 / Q6 setup — Nova (and Vega) have a recurring, UNRESOLVED failure mode:
// flaky_api fails ~45% of the time, all the way through the timeline.
for (const [agentId, n] of [['nova', 12], ['vega', 8]]) {
  for (let i = 0; i < n; i++) {
    const fails = chance(0.45)
    sessions.push(buildSession({
      agentId, taskType: chance(0.5) ? 'data-extraction' : 'analysis', dayOffset: randInt(0, DAYS - 1),
      tools: ['flaky_api', pick(['database_query', 'api_call'])],
      failedTools: fails ? ['flaky_api'] : [],
      completed: fails ? chance(0.3) : chance(0.9),
    }))
  }
}

// Q6 payoff — Atlas & Lyra solve the same class of task with cached_api
// instead of flaky_api, and it works.
for (const agentId of ['atlas', 'lyra']) {
  for (let i = 0; i < 10; i++) {
    sessions.push(buildSession({
      agentId, taskType: chance(0.5) ? 'data-extraction' : 'analysis', dayOffset: randInt(0, DAYS - 1),
      tools: ['cached_api', pick(['database_query', 'api_call'])],
      failedTools: chance(0.05) ? ['cached_api'] : [],
      completed: chance(0.95),
    }))
  }
}

// Q4 — a toolset shared across nearly the whole population for research tasks.
for (const agent of AGENTS) {
  const n = randInt(6, 10)
  for (let i = 0; i < n; i++) {
    const tools = chance(0.4) ? ['web_search', 'summarize_doc', 'vector_search'] : ['web_search', 'summarize_doc']
    const completed = chance(0.85)
    sessions.push(buildSession({
      agentId: agent.id, taskType: 'research', dayOffset: randInt(0, DAYS - 1),
      tools, failedTools: completed ? [] : (chance(0.4) ? [pick(tools)] : []),
      completed,
    }))
  }
}

// Q5 — Atlas (star) uses dry_run_check on deployment and clearly outperforms
// Nova, who never uses it. The rest of the population is a 50/50 mixed baseline.
for (let i = 0; i < 10; i++) {
  const completed = chance(0.9)
  sessions.push(buildSession({
    agentId: 'atlas', taskType: 'deployment', dayOffset: randInt(0, DAYS - 1),
    tools: chance(0.5) ? ['deploy_script', 'shell_exec', 'dry_run_check'] : ['deploy_script', 'shell_exec', 'dry_run_check', 'lint'],
    failedTools: completed ? [] : ['deploy_script'],
    completed,
  }))
}
for (let i = 0; i < 10; i++) {
  const completed = chance(0.55)
  sessions.push(buildSession({
    agentId: 'nova', taskType: 'deployment', dayOffset: randInt(0, DAYS - 1),
    tools: ['deploy_script', 'shell_exec'],
    failedTools: completed ? [] : (chance(0.6) ? ['deploy_script'] : ['shell_exec']),
    completed,
  }))
}
for (const agentId of ['vega', 'juno', 'orion', 'cass', 'lyra']) {
  for (let i = 0; i < 5; i++) {
    const useDryRun = chance(0.5)
    const completed = chance(useDryRun ? 0.8 : 0.6)
    sessions.push(buildSession({
      agentId, taskType: 'deployment', dayOffset: randInt(0, DAYS - 1),
      tools: useDryRun ? ['deploy_script', 'shell_exec', 'dry_run_check'] : ['deploy_script', 'shell_exec'],
      failedTools: completed ? [] : ['deploy_script'],
      completed,
    }))
  }
}

// ─── Phase B: background noise — realistic filler across all agents/types ─

for (const agent of AGENTS) {
  const n = randInt(20, 30)
  for (let i = 0; i < n; i++) {
    const taskType = pickWeighted(TASK_WEIGHTS_DEFAULT)
    const tools = subset(TOOLS_BY_TASK_TYPE[taskType], 1, 3)
    const completed = chance(0.75)
    sessions.push(buildSession({
      agentId: agent.id, taskType, dayOffset: randInt(0, DAYS - 1),
      tools, failedTools: completed ? [] : (chance(0.5) ? [pick(tools)] : []),
      completed,
    }))
  }
}

sessions.sort((a, b) => a.sessionStart.localeCompare(b.sessionStart))

// ─── ground truth — computed from what actually got generated ────────────

function rate(pred, arr) { return arr.length ? (arr.filter(pred).length / arr.length) : null }
function pct(x) { return x === null ? 'n/a' : `${(x * 100).toFixed(0)}%` }

const byAgent = (id) => sessions.filter((s) => s.agentId === id)
const novaDebug = byAgent('nova').filter((s) => s.taskType === 'debugging')
const novaDebugEarly = novaDebug.filter((s) => new Date(s.sessionStart) < new Date(START_DATE.getTime() + HALF * 86_400_000))
const novaDebugLate = novaDebug.filter((s) => new Date(s.sessionStart) >= new Date(START_DATE.getTime() + HALF * 86_400_000))

const flakyUsers = (id) => byAgent(id).filter((s) => s.uniqueToolsUsed.includes('flaky_api'))
const cachedUsers = (id) => byAgent(id).filter((s) => s.uniqueToolsUsed.includes('cached_api'))

const researchSharedCount = AGENTS.filter((a) =>
  byAgent(a.id).some((s) => s.taskType === 'research' && s.uniqueToolsUsed.includes('web_search') && s.uniqueToolsUsed.includes('summarize_doc'))
).length

const atlasDeploy = byAgent('atlas').filter((s) => s.taskType === 'deployment')
const novaDeploy = byAgent('nova').filter((s) => s.taskType === 'deployment')

const groundTruth = `# Ground truth — synthetic Collective Diary dataset

Generated with seed ${SEED} · ${DAYS} days (${START_DATE.toISOString().slice(0, 10)} → ${END_DATE.toISOString().slice(0, 10)}) · ${sessions.length} sessions across ${AGENTS.length} agents.

This is the answer key. Your Cypher queries should independently rediscover these numbers from the graph — use this file to check them, don't hand these numbers to the LLM directly.

## Q1/Q3 — Nova's debugging strategy change
- Early era (first half of range): ${novaDebugEarly.length} sessions, toolset {grep, read_file}, completion rate ${pct(rate((s) => s.taskCompleted, novaDebugEarly))}
- Late era (second half): ${novaDebugLate.length} sessions, toolset {grep, read_file, run_tests}, completion rate ${pct(rate((s) => s.taskCompleted, novaDebugLate))}
- Expected finding: adding run_tests correlates with a large completion-rate jump.

## Q1/Q6 — Nova's recurring failure vs. the fix other agents found
- Nova: ${flakyUsers('nova').length} sessions used flaky_api, failed in ${pct(rate((s) => s.failedToolNames.includes('flaky_api'), flakyUsers('nova')))} of them
- Vega: ${flakyUsers('vega').length} sessions used flaky_api, failed in ${pct(rate((s) => s.failedToolNames.includes('flaky_api'), flakyUsers('vega')))} of them (same unresolved problem, shared across agents)
- Atlas: ${cachedUsers('atlas').length} sessions used cached_api instead, failed in ${pct(rate((s) => s.failedToolNames.includes('cached_api'), cachedUsers('atlas')))} of them
- Lyra: ${cachedUsers('lyra').length} sessions used cached_api instead, failed in ${pct(rate((s) => s.failedToolNames.includes('cached_api'), cachedUsers('lyra')))} of them
- Expected finding: cached_api is the transferable strategy for Nova's recurring flaky_api failures.

## Q4 — Shared pattern across the population
- ${researchSharedCount}/${AGENTS.length} agents have at least one research session using {web_search, summarize_doc}
- Expected finding: this toolset is common across nearly the whole population on the "research" task type, including Nova.

## Q5 — Where Nova differs from a better performer (deployment)
- Atlas: ${atlasDeploy.length} sessions, always includes dry_run_check, completion rate ${pct(rate((s) => s.taskCompleted, atlasDeploy))}
- Nova: ${novaDeploy.length} sessions, never uses dry_run_check, completion rate ${pct(rate((s) => s.taskCompleted, novaDeploy))}
- Expected finding: dry_run_check is the differentiating tool between Atlas's and Nova's deployment outcomes.

## Agent roster (role is answer-key only — NOT written to agents.json / the graph)
${AGENTS.map((a) => `- ${a.id} (${a.name}) — ${a.role}`).join('\n')}
`

// ─── write outputs ─────────────────────────────────────────────────────

writeFileSync('data/sessions.json', JSON.stringify(sessions, null, 2))
writeFileSync('data/agents.json', JSON.stringify(AGENTS.map(({ id, name, modelId, frameworkName }) => ({ id, name, modelId, frameworkName })), null, 2))
writeFileSync('data/ground-truth.md', groundTruth)

console.log(`Generated ${sessions.length} sessions across ${AGENTS.length} agents over ${DAYS} days.`)
console.log('Wrote data/sessions.json, data/agents.json, data/ground-truth.md')
console.log('')
console.log(groundTruth)
