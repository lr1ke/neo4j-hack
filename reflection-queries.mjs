// reflection-queries.mjs
//
// The six reflection queries from the brief, each mapped to Cypher over the
// (Agent)-[:RAN]->(Session)-[:CLASSIFIED_AS]->(TaskType), (Session)-[:USED_TOOL]->(Tool)
// schema. Every function returns plain evidence objects — counts, rates, sets,
// chronological traces. None of them produce a narrative; that's the LLM's job,
// downstream, working only from what these return (see narrate.mjs).
//
// "Strategy" is never a stored fact — it's the sorted set of tool names touched
// in a session, computed here via ORDER BY + collect(), same trick used for
// chronological ordering: sort right before you aggregate.
//
// Time-bucketing convention: "early" vs "late" splits by SESSION-COUNT midpoint
// (first half of the ordered list vs second half), not calendar-date midpoint.
// This is more robust to bursty/uneven activity — see load-graph.mjs verification
// notes for why the two methods can disagree.

/** Q1 — "What failure patterns recur in my history?"
 *  Tools that failed at least twice for this agent, grouped by task type. */
export async function recurringFailures(session, agentId) {
  const result = await session.run(
    `
    MATCH (:Agent {id: $agentId})-[:RAN]->(s:Session)-[u:USED_TOOL {succeeded: false}]->(t:Tool)
    MATCH (s)-[:CLASSIFIED_AS]->(tt:TaskType)
    WITH tt.name AS taskType, t.name AS tool, count(*) AS failures, collect(s.taskDescription)[0..3] AS exampleTasks
    WHERE failures >= 2
    RETURN taskType, tool, failures, exampleTasks
    ORDER BY failures DESC
    LIMIT 10
    `,
    { agentId }
  )
  return result.records.map((r) => r.toObject())
}

/** Q2 — "Which strategies have become more successful for me over time?"
 *  Per task type: every distinct toolset used, split early/late by session count,
 *  with completion rate for each (era, toolset) pair. The LLM compares eras. */
export async function strategyEvolution(session, agentId) {
  const result = await session.run(
    `
    MATCH (:Agent {id: $agentId})-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(tt:TaskType)
    OPTIONAL MATCH (s)-[:USED_TOOL]->(tool:Tool)
    WITH tt, s, tool ORDER BY tool.name
    WITH tt, s, collect(tool.name) AS toolset
    ORDER BY s.sessionStart
    WITH tt, collect({toolset: toolset, completed: s.taskCompleted}) AS sessions
    WHERE size(sessions) >= 4
    WITH tt,
         sessions[0..size(sessions)/2]  AS early,
         sessions[size(sessions)/2..]   AS late
    UNWIND [{era: 'early', items: early}, {era: 'late', items: late}] AS bucket
    UNWIND bucket.items AS item
    WITH tt.name AS taskType, bucket.era AS era, item.toolset AS toolset,
         count(*) AS n,
         sum(CASE WHEN item.completed THEN 1 ELSE 0 END) AS completedN
    RETURN taskType, era, toolset, n, round(100.0 * completedN / n) AS completionPct
    ORDER BY taskType, era, n DESC
    `,
    { agentId }
  )
  return result.records.map((r) => r.toObject())
}

/** Q3 — "What have I changed in the way I approach <taskType> tasks?"
 *  Full chronological trace for one task type: every session's toolset + outcome,
 *  oldest first. The brief's example is debugging; works for any TaskType. */
export async function approachChange(session, agentId, taskType = 'debugging') {
  const result = await session.run(
    `
    MATCH (:Agent {id: $agentId})-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(:TaskType {name: $taskType})
    OPTIONAL MATCH (s)-[:USED_TOOL]->(tool:Tool)
    WITH s, tool ORDER BY tool.name
    WITH s, collect(tool.name) AS toolset
    RETURN toString(s.sessionStart) AS sessionStart, toolset, s.taskCompleted AS completed,
           s.toolCallsFailed AS toolCallsFailed, s.taskDescription AS taskDescription
    ORDER BY sessionStart
    `,
    { agentId, taskType }
  )
  return result.records.map((r) => r.toObject())
}

/** Q4 — "Which patterns in my behavior are also common across other agents
 *  doing similar task types?" Tools I use on a task type that at least 2 other
 *  agents also use on that same task type. */
export async function sharedPatterns(session, agentId) {
  const result = await session.run(
    `
    MATCH (me:Agent {id: $agentId})-[:RAN]->(s1:Session)-[:CLASSIFIED_AS]->(tt:TaskType),
          (s1)-[:USED_TOOL]->(t:Tool)<-[:USED_TOOL]-(s2:Session)-[:CLASSIFIED_AS]->(tt),
          (other:Agent)-[:RAN]->(s2)
    WHERE other.id <> me.id
    WITH tt.name AS taskType, t.name AS tool,
         count(DISTINCT other) AS agentsSharing,
         count(DISTINCT s2)    AS sessionsSharing,
         count(DISTINCT s1)    AS myUsage
    WHERE agentsSharing >= 2
    RETURN taskType, tool, agentsSharing, sessionsSharing, myUsage
    ORDER BY agentsSharing DESC, sessionsSharing DESC
    LIMIT 10
    `,
    { agentId }
  )
  return result.records.map((r) => r.toObject())
}

/** Helper for Q5 — for one agent + task type, what fraction of their sessions
 *  touched each tool. Rate-based, not binary "ever used" — with any amount of
 *  background noise, existence-only diffing erases real signal (an agent that
 *  uses a tool in 90% of sessions vs. one that touched it once looks identical
 *  under set membership; they are not behaviorally similar). */
export async function toolUsageRates(session, agentId, taskType) {
  const result = await session.run(
    `
    MATCH (:Agent {id: $agentId})-[:RAN]->(s0:Session)-[:CLASSIFIED_AS]->(:TaskType {name: $taskType})
    WITH collect(DISTINCT s0) AS mySessions
    UNWIND mySessions AS s
    OPTIONAL MATCH (s)-[:USED_TOOL]->(tool:Tool)
    WITH mySessions, tool.name AS toolName, collect(DISTINCT s) AS sessionsForTool
    WHERE toolName IS NOT NULL
    RETURN toolName,
           size(sessionsForTool) AS sessionsUsingIt,
           size(mySessions) AS totalSessions,
           round(100.0 * size(sessionsForTool) / size(mySessions)) AS usagePct
    ORDER BY usagePct DESC
    `,
    { agentId, taskType }
  )
  return result.records.map((r) => r.toObject())
}

function diffUsageRates(myRates, peerRates, minGapPct = 30) {
  const myMap = Object.fromEntries(myRates.map((r) => [r.toolName, r.usagePct]))
  const peerMap = Object.fromEntries(peerRates.map((r) => [r.toolName, r.usagePct]))
  const allTools = new Set([...Object.keys(myMap), ...Object.keys(peerMap)])
  const gaps = []
  for (const tool of allTools) {
    const mine = myMap[tool] ?? 0
    const theirs = peerMap[tool] ?? 0
    if (Math.abs(theirs - mine) >= minGapPct) {
      gaps.push({ tool, myUsagePct: mine, peerUsagePct: theirs })
    }
  }
  return gaps.sort((a, b) => Math.abs(b.peerUsagePct - b.myUsagePct) - Math.abs(a.peerUsagePct - a.myUsagePct))
}

/** Q5 — "Where does my behavior differ from agents who perform better on
 *  similar tasks?" Find peers who beat me on completion rate for a task type
 *  (min sample size 3, min +10pt gap), then diff per-tool usage RATES against
 *  each (see toolUsageRates — existence-only diffing is too brittle). Kept as
 *  separate queries in application code rather than one Cypher blob — much
 *  easier to test and reason about than a single nested subquery. */
export async function peerComparison(session, agentId, taskType, { minGapPct = 10, minSample = 3, minToolGapPct = 30 } = {}) {
  const ratesResult = await session.run(
    `
    MATCH (a:Agent)-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(:TaskType {name: $taskType})
    WITH a.id AS agentId, count(s) AS n, sum(CASE WHEN s.taskCompleted THEN 1 ELSE 0 END) AS completedN
    WHERE n >= $minSample
    RETURN agentId, n, round(100.0 * completedN / n) AS completionPct
    ORDER BY completionPct DESC
    `,
    { taskType, minSample }
  )
  const rates = ratesResult.records.map((r) => r.toObject())
  const mine = rates.find((r) => r.agentId === agentId)
  if (!mine) return { taskType, mine: null, betterPeers: [] }

  const betterPeers = rates.filter((r) => r.agentId !== agentId && r.completionPct > mine.completionPct + minGapPct)
  const myToolRates = await toolUsageRates(session, agentId, taskType)

  const withDiffs = []
  for (const peer of betterPeers.slice(0, 3)) {
    const peerToolRates = await toolUsageRates(session, peer.agentId, taskType)
    const notableToolGaps = diffUsageRates(myToolRates, peerToolRates, minToolGapPct)
    withDiffs.push({ ...peer, notableToolGaps })
  }

  return { taskType, mine, betterPeers: withDiffs }
}

/** Q6 — "Which successful strategies used by other agents might be relevant
 *  to my own recurring failures?" Given a (taskType, failingTool) pair — meant
 *  to be fed the top result of recurringFailures() — find alternative tools
 *  other agents use instead, on the same task type, with a decent success rate. */
export async function transferableStrategies(session, agentId, taskType, failingTool) {
  const result = await session.run(
    `
    MATCH (other:Agent)-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(:TaskType {name: $taskType})
    MATCH (s)-[u:USED_TOOL]->(altTool:Tool)
    WHERE other.id <> $agentId AND altTool.name <> $failingTool
    WITH altTool.name AS alternativeTool,
         count(DISTINCT other) AS agentsUsingIt,
         count(DISTINCT s)     AS sessions,
         count(u)              AS totalCalls,
         sum(CASE WHEN u.succeeded THEN 1 ELSE 0 END) AS succeededCalls
    WHERE totalCalls >= 3
    RETURN alternativeTool, agentsUsingIt, sessions, round(100.0 * succeededCalls / totalCalls) AS successRate
    ORDER BY successRate DESC, agentsUsingIt DESC
    LIMIT 5
    `,
    { agentId, taskType, failingTool }
  )
  return result.records.map((r) => r.toObject())
}
