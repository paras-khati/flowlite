// Load optional settings from a .env file (email credentials, PORT, ...). Needs Node 20.12+.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch { /* no .env file: fine */ }

const express = require('express');
const path = require('path');
const db = require('./db');
const { registry, nodeTypesMeta } = require('./nodes');
const { startExecution } = require('./engine');
const { reschedule } = require('./scheduler');
const templates = require('./templates');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

const hydrate = (row) => row && { ...row, active: !!row.active, nodes: JSON.parse(row.nodes), edges: JSON.parse(row.edges) };
const getWorkflow = (id) => hydrate(db.prepare('SELECT * FROM workflows WHERE id = ?').get(id));

/** Validates and normalizes a workflow payload. Throws Error with a friendly message. */
function validateWorkflow(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) throw new Error('Workflow name is required');
    if (name.length > 100) throw new Error('Workflow name is too long (max 100 characters)');
    out.name = name;
  }
  if (body.description !== undefined) out.description = String(body.description).slice(0, 500);
  if (body.nodes !== undefined || body.edges !== undefined || !partial) {
    const nodes = body.nodes ?? [];
    const edges = body.edges ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes and edges must be arrays');
    if (nodes.length > 200) throw new Error('Too many nodes (max 200)');
    const ids = new Set();
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string') throw new Error('Every node needs a string id');
      if (!registry[node.type]) throw new Error(`Unknown node type "${node.type}"`);
      if (ids.has(node.id)) throw new Error(`Duplicate node id "${node.id}"`);
      ids.add(node.id);
    }
    for (const edge of edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error('An edge points to a node that does not exist');
    }
    out.nodes = nodes.map(({ id, type, label, x, y, config }) => ({
      id, type, label, x: Number(x) || 0, y: Number(y) || 0, config: config && typeof config === 'object' ? config : {},
    }));
    out.edges = edges.map(({ id, source, target, sourceHandle }) => ({
      id: id || `${source}-${sourceHandle || 'out'}-${target}`, source, target, sourceHandle: sourceHandle || 'out',
    }));
  }
  return out;
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

const execWithLogs = (id) => {
  const execution = db.prepare(
    `SELECT e.*, w.name AS workflow_name FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id WHERE e.id = ?`
  ).get(id);
  if (!execution) return null;
  const logs = db.prepare('SELECT * FROM execution_logs WHERE execution_id = ? ORDER BY id').all(id).map((l) => ({
    ...l,
    input_data: l.input_data ? JSON.parse(l.input_data) : null,
    output_data: l.output_data ? JSON.parse(l.output_data) : null,
  }));
  return { ...execution, logs };
};

// ---------- API: meta ----------

app.get('/api/node-types', (req, res) => res.json(nodeTypesMeta()));
app.get('/api/templates', (req, res) =>
  res.json(templates.map(({ key, name, description, nodes }) => ({ key, name, description, nodeCount: nodes.length })))
);

app.post('/api/templates/:key/import', wrap((req, res) => {
  const t = templates.find((x) => x.key === req.params.key);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const info = db.prepare('INSERT INTO workflows (name, description, nodes, edges) VALUES (?, ?, ?, ?)')
    .run(t.name, t.description, JSON.stringify(t.nodes), JSON.stringify(t.edges));
  res.status(201).json(getWorkflow(info.lastInsertRowid));
}));

app.get('/api/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get().c;
  res.json({
    workflows: one('SELECT COUNT(*) c FROM workflows'),
    activeWorkflows: one('SELECT COUNT(*) c FROM workflows WHERE active = 1'),
    executions: one('SELECT COUNT(*) c FROM executions'),
    succeeded: one(`SELECT COUNT(*) c FROM executions WHERE status = 'success'`),
    failed: one(`SELECT COUNT(*) c FROM executions WHERE status = 'failed'`),
    last24h: one(`SELECT COUNT(*) c FROM executions WHERE started_at >= datetime('now', '-1 day')`),
  });
});

// ---------- API: workflows ----------

app.get('/api/workflows', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare(
    `SELECT w.id, w.name, w.description, w.active, w.created_at, w.updated_at,
            json_array_length(w.nodes) AS node_count,
            (SELECT status FROM executions WHERE workflow_id = w.id ORDER BY id DESC LIMIT 1) AS last_status,
            (SELECT started_at FROM executions WHERE workflow_id = w.id ORDER BY id DESC LIMIT 1) AS last_run,
            (SELECT COUNT(*) FROM executions WHERE workflow_id = w.id) AS run_count
     FROM workflows w WHERE w.name LIKE ? OR w.description LIKE ? ORDER BY w.updated_at DESC, w.id DESC`
  ).all(q, q);
  res.json(rows.map((r) => ({ ...r, active: !!r.active })));
});

app.post('/api/workflows', wrap((req, res) => {
  const w = validateWorkflow({ nodes: [], edges: [], ...req.body });
  const info = db.prepare('INSERT INTO workflows (name, description, nodes, edges) VALUES (?, ?, ?, ?)')
    .run(w.name, w.description || '', JSON.stringify(w.nodes), JSON.stringify(w.edges));
  res.status(201).json(getWorkflow(info.lastInsertRowid));
}));

app.get('/api/workflows/:id', (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Workflow not found' });
  res.json(w);
});

app.put('/api/workflows/:id', wrap((req, res) => {
  const existing = getWorkflow(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Workflow not found' });
  const w = validateWorkflow(req.body, { partial: true });
  const merged = { ...existing, ...w };
  db.prepare(`UPDATE workflows SET name = ?, description = ?, nodes = ?, edges = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(merged.name, merged.description || '', JSON.stringify(merged.nodes), JSON.stringify(merged.edges), existing.id);
  if (existing.active) reschedule();
  res.json(getWorkflow(existing.id));
}));

app.delete('/api/workflows/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM execution_logs WHERE execution_id IN (SELECT id FROM executions WHERE workflow_id = ?)').run(id);
  db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(id);
  db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  reschedule();
  res.json({ ok: true });
});

app.post('/api/workflows/:id/duplicate', (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Workflow not found' });
  const info = db.prepare('INSERT INTO workflows (name, description, nodes, edges) VALUES (?, ?, ?, ?)')
    .run(`${w.name} (copy)`.slice(0, 100), w.description, JSON.stringify(w.nodes), JSON.stringify(w.edges));
  res.status(201).json(getWorkflow(info.lastInsertRowid));
});

app.post('/api/workflows/:id/activate', (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Workflow not found' });
  db.prepare('UPDATE workflows SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, w.id);
  reschedule();
  res.json(getWorkflow(w.id));
});

app.post('/api/workflows/:id/run', (req, res) => {
  const w = getWorkflow(req.params.id);
  if (!w) return res.status(404).json({ error: 'Workflow not found' });
  const { executionId } = startExecution(w, { trigger: 'manual' });
  res.status(202).json({ executionId });
});

app.get('/api/workflows/:id/executions', (req, res) => {
  const rows = db.prepare('SELECT * FROM executions WHERE workflow_id = ? ORDER BY id DESC LIMIT 50').all(req.params.id);
  res.json(rows);
});

// ---------- API: executions ----------

app.get('/api/executions', (req, res) => {
  const rows = db.prepare(
    `SELECT e.*, w.name AS workflow_name FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id
     ORDER BY e.id DESC LIMIT 20`
  ).all();
  res.json(rows);
});

app.get('/api/executions/:id', (req, res) => {
  const e = execWithLogs(req.params.id);
  if (!e) return res.status(404).json({ error: 'Execution not found' });
  res.json(e);
});

// ---------- Webhooks ----------

app.all('/webhook/:workflowId/:nodeId', (req, res) => {
  const w = getWorkflow(req.params.workflowId);
  const node = w && w.nodes.find((n) => n.id === req.params.nodeId && n.type === 'webhook');
  if (!node) return res.status(404).json({ error: 'Webhook not found' });
  if (!w.active) return res.status(409).json({ error: 'Workflow is not active. Activate it in the editor first.' });
  const { executionId } = startExecution(w, {
    trigger: 'webhook',
    startNodeId: node.id,
    triggerData: {
      method: req.method,
      query: req.query,
      body: req.body && typeof req.body === 'object' ? req.body : {},
      headers: { 'content-type': req.headers['content-type'] || '' },
    },
  });
  res.status(202).json({ ok: true, executionId });
});

// JSON errors for malformed bodies etc.
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`FlowLite running on http://localhost:${PORT}`);
    reschedule();
  });
}

module.exports = app;
