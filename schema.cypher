// Collective Diary — schema for the Neo4j Mini Agentic Hack MVP.
// 4 node labels, 3 relationship types. Paste into the Aura Browser, or let
// load-graph.mjs apply these programmatically (it runs the same statements).

// Uniqueness constraints (each also creates a backing index)
CREATE CONSTRAINT agent_id_unique IF NOT EXISTS
FOR (a:Agent) REQUIRE a.id IS UNIQUE;

CREATE CONSTRAINT tool_name_unique IF NOT EXISTS
FOR (t:Tool) REQUIRE t.name IS UNIQUE;

CREATE CONSTRAINT tasktype_name_unique IF NOT EXISTS
FOR (tt:TaskType) REQUIRE tt.name IS UNIQUE;

CREATE CONSTRAINT session_id_unique IF NOT EXISTS
FOR (s:Session) REQUIRE s.sessionId IS UNIQUE;

// Index to support time-bucketed reflection queries (era splits, trends)
CREATE INDEX session_start_index IF NOT EXISTS
FOR (s:Session) ON (s.sessionStart);

// ─── Shape reference ───────────────────────────────────────────────────
//
// (:Agent {id, name, modelId, frameworkName})
//   -[:RAN]->
// (:Session {sessionId, sessionStart, sessionEnd,
//             tokenUsageInput, tokenUsageOutput,
//             toolCallsTotal, toolCallsSucceeded, toolCallsFailed,
//             taskDescription, taskCompleted})
//   -[:CLASSIFIED_AS]-> (:TaskType {name})
//   -[:USED_TOOL {succeeded: boolean}]-> (:Tool {name})
