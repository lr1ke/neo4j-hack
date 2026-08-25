#!/usr/bin/env node
// run-reflection.mjs
//
// Runs all six reflection queries against the live Aura graph for one agent,
// prints the raw evidence, then (if ANTHROPIC_API_KEY is set) narrates it
// into first-person individual + collective reflections via narrate.mjs.
// Without the key, it prints evidence only and says so — same graceful
// degradation as the missing-Neo4j-credentials check below.
//
// Usage:
//   node run-reflection.mjs [agentId] [deploymentComparisonTaskType]
//   node run-reflection.mjs nova
//   node run-reflection.mjs atlas coding

import 'dotenv/config'
import neo4j from 'neo4j-driver'
import {
  recurringFailures,
  strategyEvolution,
  approachChange,
  sharedPatterns,
  peerComparison,
  transferableStrategies,
} from './reflection-queries.mjs'
import { narrateIndividual, narrateCollective, anthropicAvailable } from './narrate.mjs'

const agentId = process.argv[2] ?? 'nova'
const peerTaskType = process.argv[3] ?? 'deployment' // task type with the clearest engineered peer gap

const { NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD } = process.env
if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  console.error('Missing NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD — see .env.example.')
  process.exit(1)
}

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
  { disableLosslessIntegers: true }
)

async function main() {
  const session = driver.session()
  try {
    console.log(`\n=== Reflection evidence for agent "${agentId}" ===\n`)

    const failures = await recurringFailures(session, agentId)
    console.log('Q1 — recurring failure patterns')
    console.table(failures.map(({ exampleTasks, ...rest }) => rest))

    const evolution = await strategyEvolution(session, agentId)
    console.log('\nQ2 — strategy evolution (early vs. late, per task type)')
    console.table(evolution.map((e) => ({ ...e, toolset: e.toolset.join(', ') })))

    const debugTrace = await approachChange(session, agentId, 'debugging')
    console.log('\nQ3 — chronological trace: debugging approach')
    console.table(debugTrace.map((s) => ({
      sessionStart: s.sessionStart.slice(0, 16),
      toolset: s.toolset.join(', '),
      completed: s.completed,
      toolCallsFailed: s.toolCallsFailed,
    })))

    const shared = await sharedPatterns(session, agentId)
    console.log('\nQ4 — patterns shared with other agents')
    console.table(shared)

    const peerCmp = await peerComparison(session, agentId, peerTaskType)
    console.log(`\nQ5 — peer comparison on "${peerTaskType}"`)
    console.log('  mine:', peerCmp.mine)
    for (const peer of peerCmp.betterPeers) {
      console.log(`  better peer: ${peer.agentId} (${peer.completionPct}%, n=${peer.n})`)
      if (peer.notableToolGaps.length === 0) {
        console.log('    no notable per-tool usage-rate gaps found')
      } else {
        for (const gap of peer.notableToolGaps) {
          console.log(`    ${gap.tool}: I use it ${gap.myUsagePct}% of sessions, they use it ${gap.peerUsagePct}%`)
        }
      }
    }

    let top = null
    let transferable = []
    if (failures.length > 0) {
      top = failures[0]
      transferable = await transferableStrategies(session, agentId, top.taskType, top.tool)
      console.log(`\nQ6 — alternatives to "${top.tool}" failures in "${top.taskType}"`)
      console.table(transferable)
    } else {
      console.log('\nQ6 — skipped: no recurring failures found for this agent (nothing to find an alternative to)')
    }

    console.log('\n' + '─'.repeat(60))

    if (!anthropicAvailable()) {
      console.log('\nANTHROPIC_API_KEY not set — skipping narration. Raw evidence above is what would be handed to the LLM.')
    } else {
      console.log('\nNarrating individual reflection (Q1-Q3)...')
      const individual = await narrateIndividual({
        agentId,
        recurringFailures: failures,
        strategyEvolution: evolution,
        approachChange: debugTrace,
        approachTaskType: 'debugging',
      })
      console.log(`\n--- Individual reflection: ${agentId} ---\n`)
      console.log(individual)

      if (top) {
        console.log('\nNarrating collective reflection (Q4-Q6)...')
        const collective = await narrateCollective({
          agentId,
          sharedPatterns: shared,
          peerComparison: peerCmp,
          transferableStrategies: transferable,
          failingTool: top.tool,
          failingTaskType: top.taskType,
        })
        console.log(`\n--- Collective reflection: ${agentId} ---\n`)
        console.log(collective)
      } else {
        console.log('\nCollective reflection skipped — no recurring failure to anchor Q6 evidence on.')
      }
    }
  } finally {
    await session.close()
    await driver.close()
  }
}

main().catch((err) => {
  console.error('Reflection query run failed:', err.message)
  process.exit(1)
})
