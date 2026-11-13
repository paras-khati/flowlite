/**
 * Execution engine.
 *
 * Walks the workflow graph from a trigger node:
 *   run node -> collect output -> follow the connected edge(s) -> pass output on.
 * Sequential only (depth-first). Condition nodes pick which edge to follow.
 * Every node run is written to execution_logs so the UI can poll progress.
 */
const db = require('./db');
const { registry } = require('./nodes');

const MAX_STEPS = 100; // protects against infinite loops
const MAX_RUNTIME_MS = 120000; // 2 minutes

const now = () => new Date().toISOString();

function toJson(value) {
  let s = JSON.stringify(value === undefined ? null : value);
  if (s && s.length > 100000) s = JSON.stringify({ truncated: true, preview: s.slice(0, 2000) });
  return s;
}

const insertExecution = db.prepare(
  'INSERT INTO executions (workflow_id, status, trigger, started_at) VALUES (?, ?, ?, ?)'
);
const finishExecution = db.prepare(
  'UPDATE executions SET status = ?, completed_at = ?, error = ? WHERE id = ?'
);
const insertLog = db.prepare(
  `INSERT INTO execution_logs (execution_id, node_id, node_type, node_label, status, input_data, started_at)
   VALUES (?, ?, ?, ?, 'running', ?, ?)`
);
const finishLog = db.prepare(
  `UPDATE execution_logs SET status = ?, output_data = ?, error_message = ?, completed_at = ? WHERE id = ?`
);

function pickStartNode(workflow, startNodeId) {
  const nodes = workflow.nodes;
  if (startNodeId) return nodes.find((n) => n.id === startNodeId);
  const isTrigger = (n) => registry[n.type] && registry[n.type].isTrigger;
  return nodes.find((n) => n.type === 'manualTrigger') || nodes.find(isTrigger);
}

/**
 * Starts an execution. Returns { executionId, done } immediately;
 * `done` resolves when the run has finished (the HTTP route doesn't wait for it).
 */
function startExecution(workflow, { trigger = 'manual', startNodeId, triggerData } = {}) {
  const startNode = pickStartNode(workflow, startNodeId);
  const executionId = insertExecution.run(workflow.id, 'running', trigger, now()).lastInsertRowid;

  const done = (async () => {
    if (!startNode) {
      finishExecution.run('failed', now(), 'No trigger node found. Add a trigger (e.g. Manual Trigger).', executionId);
      return;
    }

    const nodeById = Object.fromEntries(workflow.nodes.map((n) => [n.id, n]));
    const vars = {};
    const deadline = Date.now() + MAX_RUNTIME_MS;
    let steps = 0;

    async function visit(node, input) {
      if (++steps > MAX_STEPS) {
        throw new Error(`Execution limit reached (${MAX_STEPS} node runs). Is there a loop in your workflow?`);
      }
      if (Date.now() > deadline) throw new Error('Execution time limit reached');

      const label = node.label || (registry[node.type] && registry[node.type].label) || node.type;
      const logId = insertLog.run(executionId, node.id, node.type, label, toJson(input), now()).lastInsertRowid;

      const def = registry[node.type];
      let result;
      try {
        if (!def) throw new Error(`Unknown node type "${node.type}"`);
        result = await def.execute({
          config: node.config || {},
          input,
          vars,
          context: { triggerData, workflowId: workflow.id },
        });
      } catch (err) {
        finishLog.run('error', null, err.message, now(), logId);
        err.nodeLabel = label;
        throw err;
      }
      finishLog.run('success', toJson(result.output), null, now(), logId);

      const nextEdges = workflow.edges.filter(
        (e) => e.source === node.id && (result.branch ? e.sourceHandle === result.branch : true)
      );
      for (const edge of nextEdges) {
        const next = nodeById[edge.target];
        if (next) await visit(next, result.output);
      }
    }

    try {
      await visit(startNode, triggerData || {});
      finishExecution.run('success', now(), null, executionId);
    } catch (err) {
      const msg = err.nodeLabel ? `${err.nodeLabel}: ${err.message}` : err.message;
      finishExecution.run('failed', now(), msg, executionId);
    }
  })();

  return { executionId, done };
}

module.exports = { startExecution };
