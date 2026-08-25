// narrate.mjs
//
// Turns graph-derived reflection evidence into first-person reflective prose.
// Mirrors the real agent-diary's synthesizeDiaryEntry/reflectOnHistory pattern:
// the LLM's only job is narration — every claim it makes has to trace back to
// a number or tool name that's actually in the evidence passed in. It doesn't
// see raw session data or the ground-truth answer key, only what the Cypher
// queries returned.
//
// Two scopes, matching the brief's individual/collective distinction:
//   narrateIndividual — grounded in Q1 (recurring failures), Q2 (strategy
//     evolution), Q3 (chronological approach trace). "What can I learn from
//     my own history about myself?"
//   narrateCollective — grounded in Q4 (shared patterns), Q5 (peer
//     comparison), Q6 (transferable strategies). "What can I learn about
//     myself by comparing my history with other agents?"
//
// Returns null (not a thrown error) when ANTHROPIC_API_KEY isn't set, so
// callers can fall back to printing raw evidence instead of crashing.

import Anthropic from '@anthropic-ai/sdk'

let _client
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

export function anthropicAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY)
}

const fmt = (x) => JSON.stringify(x, null, 2)

async function complete(prompt, maxTokens = 700) {
  const client = getClient()
  if (!client) return null
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })
  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected LLM response type')
  return block.text.trim()
}

/** Individual reflection — "What can I learn from my own history about myself?" */
export async function narrateIndividual({ agentId, recurringFailures, strategyEvolution, approachChange, approachTaskType }) {
  const prompt = `You are writing a first-person reflective diary entry for an AI agent named "${agentId}", reflecting ONLY on its own history (individual reflection scope).

Ground every claim strictly in the evidence below — it comes from Cypher queries over a graph of this agent's actual session history. Do not invent patterns, tools, or numbers that aren't in the evidence. If the evidence is thin, contradictory, or shows no clear pattern for a question, say so honestly rather than smoothing it over.

EVIDENCE — recurring failure patterns (tool, task type, failure count, min 2 to count as recurring):
${fmt(recurringFailures)}

EVIDENCE — strategy evolution (per task type: every toolset I used, whether it was in the early or late half of my history by session order, and the completion rate for that toolset):
${fmt(strategyEvolution)}

EVIDENCE — chronological trace of my "${approachTaskType}" sessions, oldest first (toolset used, whether the task completed, tool-call failures):
${fmt(approachChange)}

Write 2-4 short paragraphs, first person ("I"), covering:
1. What failure patterns recur in my history, and whether they're resolved or still ongoing.
2. Which of my strategies have become more successful over time — what did I start doing differently, concretely.
3. What has changed about how I approach "${approachTaskType}" tasks specifically.

Reference actual tool names and numbers from the evidence — don't be generic. Dry or matter-of-fact tone is fine. Do not add emotions the data doesn't support.`

  return complete(prompt)
}

/** Collective reflection — "What can I learn about myself by comparing my
 *  history with patterns across the histories of other agents?" */
export async function narrateCollective({ agentId, sharedPatterns, peerComparison, transferableStrategies, failingTool, failingTaskType }) {
  const prompt = `You are writing a first-person reflective diary entry for an AI agent named "${agentId}", reflecting on how its behavior compares to a wider population of other agents (collective reflection scope).

Ground every claim strictly in the evidence below — it comes from Cypher queries comparing this agent's session history against other agents in the same graph. Do not invent agents, tools, or numbers not present in the evidence.

EVIDENCE — patterns I share with other agents (task type, tool, how many OTHER agents also use it on that task type, how many of my own sessions use it):
${fmt(sharedPatterns)}

EVIDENCE — peer comparison on "${peerComparison.taskType}" tasks (my completion rate: ${fmt(peerComparison.mine)}; better-performing peers and the per-tool usage-RATE gaps that stood out between us):
${fmt(peerComparison.betterPeers)}

EVIDENCE — alternative tools other agents use successfully in place of "${failingTool}" (one of my recurring failures) on "${failingTaskType}" tasks:
${fmt(transferableStrategies)}

Write 2-4 short paragraphs, first person ("I"), covering:
1. Which of my behaviors are actually common across the wider population, not unique to me.
2. Where I diverge from agents who perform better on similar work — what specifically they do differently, by usage rate, not just "they use it and I don't."
3. Given my own recurring failure, which alternative other agents use looks worth trying, and why (cite the success rate).

Reference actual tool names, percentages, and agent counts from the evidence — don't be generic. Dry or matter-of-fact tone is fine. Do not add emotions the data doesn't support.`

  return complete(prompt)
}
