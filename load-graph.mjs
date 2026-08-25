#!/usr/bin/env node
// load-graph.mjs
//
// Loads data/agents.json + data/sessions.json into a Neo4j Aura Free instance
// and runs a few verification queries against the live graph so you can
// confirm the engineered patterns actually made it in.
//
// Requires env vars — copy .env.example to .env and fill in your Aura Free
// credentials (from the "Connect" panel in the Aura console):
//   NEO4J_URI       e.g. neo4j+s://xxxxxxxx.databases.neo4j.io
//   NEO4J_USERNAME  usually "neo4j"
//   NEO4J_PASSWORD
//
// Run:  node load-graph.mjs          (wipes the DB first, then reloads)
//       node load-graph.mjs --keep   (loads without wiping — safe to re-run,
//                                     MERGE makes it idempotent either way)

import 'dotenv/config'
import neo4j from 'neo4j-driver'
import { readFileSync } from 'node:fs'

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env

if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  console.error(
    'Missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD.\n' +
    'Copy .env.example to .env and fill in your Aura Free instance credentials.'
  )
  process.exit(1)
}

const agents = JSON.parse(readFileSync(new URL('./data/agents.json', import.meta.url), 'utf8'))
const sessions = JSON.parse(readFileSync(new URL('./data/sessions.json', import.meta.url), 'utf8'))

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
  { disableLosslessIntegers: true } // plain JS numbers back from the driver — fine at this scale
)

const CONSTRAINTS = [
  'CREATE CONSTRAINT agent_id_unique IF NOT EXISTS FOR (a:Agent) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT tool_name_unique IF NOT EXISTS FOR (t:Tool) REQUIRE t.name IS UNIQUE',
  'CREATE CONSTRAINT tasktype_name_unique IF NOT EXISTS FOR (tt:TaskType) REQUIRE tt.name IS UNIQUE',
  'CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (s:Session) REQUIRE s.sessionId IS UNIQUE',
  'CREATE INDEX session_start_index IF NOT EXISTS FOR (s:Session) ON (s.sessionStart)',
]

const LOAD_AGENTS = `
  UNWIND $agents AS a
  MERGE (ag:Agent {id: a.id})
  SET ag.name = a.name, ag.modelId = a.modelId, ag.frameworkName = a.frameworkName
`

const LOAD_SESSIONS = `
  UNWIND $sessions AS s
  MERGE (a:Agent {id: s.agentId})
  MERGE (tt:TaskType {name: s.taskType})
  MERGE (sess:Session {sessionId: s.sessionId})
  SET sess.sessionStart     = datetime(s.sessionStart),
      sess.sessionEnd       = datetime(s.sessionEnd),
      sess.tokenUsageInput  = s.tokenUsageInput,
      sess.tokenUsageOutput = s.tokenUsageOutput,
      sess.toolCallsTotal   = s.toolCallsTotal,
      sess.toolCallsSucceeded = s.toolCallsSucceeded,
      sess.toolCallsFailed  = s.toolCallsFailed,
      sess.taskDescription  = s.taskDescription,
      sess.taskCompleted    = s.taskCompleted
  MERGE (a)-[:RAN]->(sess)
  MERGE (sess)-[:CLASSIFIED_AS]->(tt)
  WITH sess, s
  UNWIND s.uniqueToolsUsed AS toolName
  MERGE (t:Tool {name: toolName})
  MERGE (sess)-[u:USED_TOOL]->(t)
  SET u.succeeded = NOT toolName IN s.failedToolNames
`

const WIPE = 'MATCH (n) DETACH DELETE n'

const VERIFY_QUERIES = [
  {
    label: 'Node counts by label',
    cypher: `
      MATCH (n)
      WITH labels(n)[0] AS label, count(*) AS n
      RETURN label, n ORDER BY label
    `,
  },
  {
    label: 'Relationship counts by type',
    cypher: `
      MATCH ()-[r]->()
      WITH type(r) AS rel, count(*) AS n
      RETURN rel, n ORDER BY rel
    `,
  },
  {
    label: 'Nova debugging: early vs. late completion rate — ground truth expects ~60% -> ~89%',
    cypher: `
      MATCH (:Agent {id:'nova'})-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(:TaskType {name:'debugging'})
      WITH s ORDER BY s.sessionStart
      WITH collect(s) AS xs
      WITH xs[0..size(xs)/2] AS early, xs[size(xs)/2..] AS late
      RETURN
        size(early) AS earlyCount,
        round(100.0 * size([x IN early WHERE x.taskCompleted]) / size(early)) AS earlyCompletionPct,
        size(late) AS lateCount,
        round(100.0 * size([x IN late WHERE x.taskCompleted]) / size(late)) AS lateCompletionPct
    `,
  },
  {
    label: "Nova's flaky_api failures vs. Atlas/Lyra's cached_api — ground truth expects ~35% vs ~9%",
    cypher: `
      MATCH (a:Agent)-[:RAN]->(s:Session)-[u:USED_TOOL]->(t:Tool)
      WHERE t.name IN ['flaky_api', 'cached_api']
      WITH a.id AS agentId, t.name AS tool, count(*) AS uses,
           size([x IN collect(u) WHERE x.succeeded = false]) AS failures
      RETURN agentId, tool, uses, round(100.0 * failures / uses) AS failurePct
      ORDER BY tool, agentId
    `,
  },
  {
    label: 'Atlas vs. Nova on deployment — ground truth expects ~92% vs ~46%',
    cypher: `
      MATCH (a:Agent)-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(:TaskType {name:'deployment'})
      WHERE a.id IN ['atlas', 'nova']
      WITH a.id AS agentId, collect(s) AS sessions
      RETURN agentId, size(sessions) AS n,
             round(100.0 * size([x IN sessions WHERE x.taskCompleted]) / size(sessions)) AS completionPct
      ORDER BY agentId
    `,
  },
  {
    label: 'Agents sharing {web_search, summarize_doc} on research tasks — ground truth expects 7/7',
    cypher: `
      MATCH (a:Agent)-[:RAN]->(s:Session)-[:CLASSIFIED_AS]->(:TaskType {name:'research'})
      MATCH (s)-[:USED_TOOL]->(t1:Tool {name:'web_search'})
      MATCH (s)-[:USED_TOOL]->(t2:Tool {name:'summarize_doc'})
      RETURN count(DISTINCT a) AS agentsSharingPattern
    `,
  },
]

async function run() {
  const session = driver.session()
  try {
    console.log('Verifying connectivity to Aura...')
    await driver.verifyConnectivity()
    console.log('Connected.\n')

    if (!process.argv.includes('--keep')) {
      console.log('Wiping existing graph...')
      await session.run(WIPE)
    }

    console.log('Applying constraints + indexes...')
    for (const stmt of CONSTRAINTS) await session.run(stmt)

    console.log(`Loading ${agents.length} agents...`)
    await session.run(LOAD_AGENTS, { agents })

    console.log(`Loading ${sessions.length} sessions (+ TaskType/Tool nodes + relationships)...`)
    await session.run(LOAD_SESSIONS, { sessions })

    console.log('\n--- Verification (compare against data/ground-truth.md) ---\n')
    for (const { label, cypher } of VERIFY_QUERIES) {
      const result = await session.run(cypher)
      console.log(`• ${label}`)
      for (const record of result.records) console.log('   ', record.toObject())
      console.log('')
    }

    console.log('Load complete.')
  } finally {
    await session.close()
    await driver.close()
  }
}

run().catch((err) => {
  console.error('Load failed:', err.message)
  process.exit(1)
})
