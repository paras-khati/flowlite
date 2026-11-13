/* FlowLite frontend - plain JavaScript, no build step. */
'use strict';

// ====================== helpers ======================
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
}

function parseDate(s) {
  if (!s) return null;
  return new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
}
const fmtDate = (s) => (s ? parseDate(s).toLocaleString() : '-');
function fmtDuration(start, end) {
  if (!start || !end) return '';
  const ms = parseDate(end) - parseDate(start);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
const badge = (status) => (status ? `<span class="badge ${esc(status)}">${esc(status)}</span>` : '<span class="badge">never run</span>');

const CAT_ICON = { Triggers: '⚡', Data: '🧩', Logic: '🔀', API: '🌐', Utilities: '🛠', Communication: '✉️', Output: '📤' };

let nodeTypes = [];
let typeByKey = {};
async function loadTypes() {
  if (nodeTypes.length) return;
  nodeTypes = await api('GET', '/api/node-types');
  typeByKey = Object.fromEntries(nodeTypes.map((t) => [t.type, t]));
}

// ====================== router ======================
let teardown = null;
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

async function route() {
  if (teardown) { teardown(); teardown = null; }
  try {
    await loadTypes();
    const hash = location.hash.slice(1) || '/';
    const m = hash.match(/^\/editor\/(\d+)(?:\/exec\/(\d+))?$/);
    if (m) await renderEditor(Number(m[1]), m[2] ? Number(m[2]) : null);
    else await renderDashboard();
  } catch (err) {
    $('#app').innerHTML = `<div class="dash"><div class="empty">Something went wrong: ${esc(err.message)}<br><br><a href="#/">Back to dashboard</a></div></div>`;
  }
}

// ====================== dashboard ======================
async function renderDashboard() {
  $('#app').innerHTML = `
    <div class="dash">
      <div class="dash-head">
        <div class="logo">Flow<span>Lite</span></div>
        <div class="spacer"></div>
        <button id="import-btn">Import JSON</button>
        <input type="file" id="import-file" accept="application/json" hidden />
        <button class="primary" id="new-btn">+ New workflow</button>
      </div>
      <div class="stats" id="stats"></div>
      <h2 class="section">Workflows <input id="search" placeholder="Search workflows..." /></h2>
      <div class="cards" id="wf-list"></div>
      <h2 class="section">Recent executions</h2>
      <div id="recent"></div>
      <h2 class="section">Start from a template</h2>
      <div class="cards" id="templates"></div>
    </div>`;

  $('#new-btn').onclick = async () => {
    const name = prompt('Workflow name:', 'My workflow');
    if (!name) return;
    try {
      const wf = await api('POST', '/api/workflows', { name, nodes: [], edges: [] });
      location.hash = `#/editor/${wf.id}`;
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#import-btn').onclick = () => $('#import-file').click();
  $('#import-file').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const wf = await api('POST', '/api/workflows', { name: data.name || 'Imported workflow', description: data.description, nodes: data.nodes, edges: data.edges });
      toast('Workflow imported', 'success');
      location.hash = `#/editor/${wf.id}`;
    } catch (e) { toast(`Import failed: ${e.message}`, 'error'); }
  };

  let searchTimer;
  $('#search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadWorkflows, 200); };

  async function loadWorkflows() {
    const q = $('#search').value;
    const list = await api('GET', `/api/workflows?q=${encodeURIComponent(q)}`);
    const box = $('#wf-list');
    if (!list.length) {
      box.innerHTML = `<div class="empty" style="grid-column:1/-1">${q ? 'No workflows match your search.' : 'No workflows yet. Create one or start from a template below.'}</div>`;
      return;
    }
    box.innerHTML = list.map((w) => `
      <div class="card">
        <h3 data-open="${w.id}">${esc(w.name)}</h3>
        <p>${esc(w.description || 'No description')}</p>
        <div class="meta">
          ${badge(w.last_status)} ${w.active ? '<span class="badge active">active</span>' : ''}
          <span>${w.node_count} nodes</span><span>${w.run_count} runs</span>
          ${w.last_run ? `<span>last: ${esc(fmtDate(w.last_run))}</span>` : ''}
        </div>
        <div class="actions">
          <button data-open="${w.id}">Open</button>
          <button data-dup="${w.id}">Duplicate</button>
          <button class="danger" data-del="${w.id}" data-name="${esc(w.name)}">Delete</button>
        </div>
      </div>`).join('');
  }

  $('#wf-list').onclick = async (ev) => {
    const t = ev.target.closest('[data-open],[data-dup],[data-del]');
    if (!t) return;
    try {
      if (t.dataset.open) location.hash = `#/editor/${t.dataset.open}`;
      else if (t.dataset.dup) { await api('POST', `/api/workflows/${t.dataset.dup}/duplicate`); toast('Duplicated', 'success'); refresh(); }
      else if (t.dataset.del && confirm(`Delete "${t.dataset.name}" and its execution history?`)) {
        await api('DELETE', `/api/workflows/${t.dataset.del}`); refresh();
      }
    } catch (e) { toast(e.message, 'error'); }
  };

  async function loadStats() {
    const s = await api('GET', '/api/stats');
    const rate = s.executions ? Math.round((s.succeeded / s.executions) * 100) + '%' : '-';
    $('#stats').innerHTML = [
      [s.workflows, 'Workflows'], [s.activeWorkflows, 'Active'], [s.executions, 'Total executions'],
      [rate, 'Success rate'], [s.failed, 'Failed'], [s.last24h, 'Runs (24h)'],
    ].map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  }

  async function loadRecent() {
    const rows = await api('GET', '/api/executions');
    $('#recent').innerHTML = rows.length
      ? `<table class="table"><thead><tr><th>#</th><th>Workflow</th><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th></tr></thead><tbody>
          ${rows.map((r) => `<tr data-wf="${r.workflow_id}" data-ex="${r.id}"><td>${r.id}</td><td>${esc(r.workflow_name || '(deleted)')}</td><td>${badge(r.status)}</td><td>${esc(r.trigger)}</td><td>${esc(fmtDate(r.started_at))}</td><td>${fmtDuration(r.started_at, r.completed_at)}</td></tr>`).join('')}
        </tbody></table>`
      : '<div class="empty">Nothing has run yet.</div>';
  }
  $('#recent').onclick = (ev) => {
    const tr = ev.target.closest('tr[data-ex]');
    if (tr && tr.dataset.wf) location.hash = `#/editor/${tr.dataset.wf}/exec/${tr.dataset.ex}`;
  };

  async function loadTemplates() {
    const list = await api('GET', '/api/templates');
    $('#templates').innerHTML = list.map((t) => `
      <div class="card"><h3>${esc(t.name)}</h3><p>${esc(t.description)}</p>
        <div class="meta"><span>${t.nodeCount} nodes</span></div>
        <div class="actions"><button class="primary" data-tpl="${esc(t.key)}">Use template</button></div></div>`).join('');
  }
  $('#templates').onclick = async (ev) => {
    const b = ev.target.closest('[data-tpl]');
    if (!b) return;
    try {
      const wf = await api('POST', `/api/templates/${b.dataset.tpl}/import`);
      location.hash = `#/editor/${wf.id}`;
    } catch (e) { toast(e.message, 'error'); }
  };

  const refresh = () => Promise.all([loadWorkflows(), loadStats(), loadRecent()]);
  await Promise.all([refresh(), loadTemplates()]);
}

// ====================== editor ======================
const NODE_W = 200;
const PORT_Y = 24; // y offset of first port centre
const PORT_GAP = 28;
const nodeHeight = (type) => (typeByKey[type] && typeByKey[type].outputs.length > 1 ? 76 : 48);

async function renderEditor(workflowId, execId) {
  const wf = await api('GET', `/api/workflows/${workflowId}`);

  const S = {
    wf,
    view: { x: 40, y: 40, z: 1 },
    sel: null, // {kind:'node'|'edge', id}
    dirty: false,
    exec: null,
    openLogs: new Set(),
    tab: 'logs',
    collapsed: false,
    history: [],
    pollTimer: null,
    running: false,
  };

  $('#app').innerHTML = `
    <div class="editor">
      <div class="topbar">
        <button id="back">← Back</button>
        <input class="name" id="wf-name" value="${esc(wf.name)}" />
        <span class="status" id="save-status">Saved</span>
        <div class="spacer"></div>
        <label class="switch" title="Active workflows respond to Schedule and Webhook triggers">
          <input type="checkbox" id="active" ${wf.active ? 'checked' : ''} /> Active
        </label>
        <button id="export">Export</button>
        <button id="save">Save</button>
        <button class="primary" id="run">▶ Run</button>
      </div>
      <div class="main">
        <div class="sidebar" id="palette"></div>
        <div class="canvas" id="canvas">
          <div class="world" id="world">
            <svg class="edges" id="edges"></svg>
            <div id="nodes"></div>
          </div>
          <div class="empty-canvas" id="empty">Drag a node from the left, or click it, to start.</div>
          <div class="zoom"><button id="zout">−</button><button id="zfit">Fit</button><button id="zin">+</button></div>
        </div>
        <div class="panel" id="panel"></div>
      </div>
      <div class="bottom" id="bottom">
        <div class="tabs">
          <button class="tab on" data-tab="logs">Execution log</button>
          <button class="tab" data-tab="history">History</button>
          <div class="spacer"></div>
          <button class="tab" id="collapse">Hide ▾</button>
        </div>
        <div class="bottom-body" id="bottom-body"></div>
      </div>
    </div>`;

  const canvas = $('#canvas');
  const world = $('#world');
  const nodesEl = $('#nodes');
  const edgesEl = $('#edges');

  // ---------- palette ----------
  const cats = [...new Set(nodeTypes.map((t) => t.category))];
  $('#palette').innerHTML =
    cats.map((c) => `<h4>${c}</h4>` + nodeTypes.filter((t) => t.category === c).map((t) =>
      `<div class="palette-item" draggable="true" data-type="${t.type}" title="${esc(t.description)}">${CAT_ICON[c] || '•'} ${esc(t.label)}</div>`).join('')).join('') +
    '<div class="hint">Drag onto the canvas or click to add. Drag from a node\'s right dot to another node to connect. Select + <b>Delete</b> removes a node or connection.</div>';

  $('#palette').addEventListener('click', (ev) => {
    const it = ev.target.closest('.palette-item');
    if (!it) return;
    const rect = canvas.getBoundingClientRect();
    const n = S.wf.nodes.length % 6;
    const p = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addNode(it.dataset.type, p.x - NODE_W / 2 + n * 24, p.y - 24 + n * 24);
  });
  $('#palette').addEventListener('dragstart', (ev) => {
    const it = ev.target.closest('.palette-item');
    if (it) ev.dataTransfer.setData('text/plain', it.dataset.type);
  });
  canvas.addEventListener('dragover', (ev) => ev.preventDefault());
  canvas.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const type = ev.dataTransfer.getData('text/plain');
    if (!typeByKey[type]) return;
    const p = toWorld(ev.clientX, ev.clientY);
    addNode(type, p.x - NODE_W / 2, p.y - 24);
  });

  // ---------- coordinates / view ----------
  function toWorld(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z };
  }
  function applyView() {
    world.style.transform = `translate(${S.view.x}px, ${S.view.y}px) scale(${S.view.z})`;
    canvas.style.backgroundPosition = `${S.view.x}px ${S.view.y}px`;
    canvas.style.backgroundSize = `${22 * S.view.z}px ${22 * S.view.z}px`;
  }
  function zoomAt(cx, cy, factor) {
    const r = canvas.getBoundingClientRect();
    const z = Math.min(2, Math.max(0.3, S.view.z * factor));
    const k = z / S.view.z;
    const px = cx - r.left, py = cy - r.top;
    S.view.x = px - (px - S.view.x) * k;
    S.view.y = py - (py - S.view.y) * k;
    S.view.z = z;
    applyView();
  }
  function fitView() {
    const r = canvas.getBoundingClientRect();
    if (!S.wf.nodes.length) { S.view = { x: 40, y: 40, z: 1 }; return applyView(); }
    const xs = S.wf.nodes.map((n) => n.x), ys = S.wf.nodes.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + NODE_W;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + 80;
    const z = Math.min(1, Math.max(0.3, Math.min((r.width - 80) / (maxX - minX), (r.height - 80) / (maxY - minY))));
    S.view = { z, x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z };
    applyView();
  }
  canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });
  $('#zin').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2); };
  $('#zout').onclick = () => { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2); };
  $('#zfit').onclick = fitView;

  // ---------- model ops ----------
  function markDirty() {
    S.dirty = true;
    $('#save-status').textContent = 'Unsaved';
  }
  const nodeById = (id) => S.wf.nodes.find((n) => n.id === id);

  function addNode(type, x, y) {
    const def = typeByKey[type];
    let max = 0;
    S.wf.nodes.forEach((n) => { const m = /^n(\d+)$/.exec(n.id); if (m) max = Math.max(max, Number(m[1])); });
    const node = { id: `n${max + 1}`, type, x: Math.round(x), y: Math.round(y), config: JSON.parse(JSON.stringify(def.defaults)) };
    S.wf.nodes.push(node);
    markDirty();
    renderGraph();
    select({ kind: 'node', id: node.id });
  }
  function duplicateNode(id) {
    const src = nodeById(id);
    if (!src) return;
    let max = 0;
    S.wf.nodes.forEach((n) => { const m = /^n(\d+)$/.exec(n.id); if (m) max = Math.max(max, Number(m[1])); });
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = `n${max + 1}`; copy.x += 30; copy.y += 40;
    S.wf.nodes.push(copy);
    markDirty(); renderGraph(); select({ kind: 'node', id: copy.id });
  }
  function deleteSelection() {
    if (!S.sel) return;
    if (S.sel.kind === 'node') {
      S.wf.nodes = S.wf.nodes.filter((n) => n.id !== S.sel.id);
      S.wf.edges = S.wf.edges.filter((e) => e.source !== S.sel.id && e.target !== S.sel.id);
    } else {
      S.wf.edges = S.wf.edges.filter((e) => e.id !== S.sel.id);
    }
    S.sel = null;
    markDirty(); renderGraph(); renderPanel();
  }
  function addEdge(source, handle, target) {
    if (source === target) return;
    if (S.wf.edges.some((e) => e.source === source && e.sourceHandle === handle && e.target === target)) return;
    const tdef = typeByKey[nodeById(target).type];
    if (tdef.isTrigger) { toast('Triggers cannot have incoming connections', 'error'); return; }
    S.wf.edges.push({ id: `${source}-${handle}-${target}`, source, target, sourceHandle: handle });
    markDirty(); renderEdges();
  }

  // ---------- rendering the graph ----------
  function portPos(nodeId, handle, isInput) {
    const n = nodeById(nodeId);
    if (!n) return { x: 0, y: 0 };
    if (isInput) return { x: n.x, y: n.y + PORT_Y };
    const outs = typeByKey[n.type].outputs;
    const i = Math.max(0, outs.indexOf(handle));
    return { x: n.x + NODE_W, y: n.y + PORT_Y + i * PORT_GAP };
  }
  function curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  function renderGraph() {
    nodesEl.innerHTML = '';
    for (const n of S.wf.nodes) {
      const def = typeByKey[n.type];
      const el = document.createElement('div');
      el.className = `node cat-${def.category}`;
      el.dataset.id = n.id;
      el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
      el.style.height = nodeHeight(n.type) + 'px';
      el.title = def.description;
      el.innerHTML =
        `<div class="node-cat"></div><div class="node-head"><span>${CAT_ICON[def.category] || '•'}</span><span class="title">${esc(n.label || def.label)}</span></div>` +
        (def.isTrigger ? '' : '<div class="port in" data-port="in"></div>') +
        def.outputs.map((h, i) =>
          `<div class="port out" data-handle="${h}" style="top:${PORT_Y - 7 + i * PORT_GAP}px"></div>` +
          (def.outputs.length > 1 ? `<span class="port-label" style="top:${PORT_Y - 8 + i * PORT_GAP}px">${h.toUpperCase()}</span>` : '')).join('');
      nodesEl.appendChild(el);
    }
    $('#empty').style.display = S.wf.nodes.length ? 'none' : 'flex';
    renderEdges();
    applySelectionClasses();
    applyExecutionClasses();
  }

  function renderEdges(temp) {
    let html = '';
    const done = executedEdges();
    for (const e of S.wf.edges) {
      const a = portPos(e.source, e.sourceHandle, false);
      const b = portPos(e.target, null, true);
      const d = curve(a, b);
      const cls = ['edge'];
      if (done.has(e.id)) cls.push('done');
      if (S.sel && S.sel.kind === 'edge' && S.sel.id === e.id) cls.push('selected');
      html += `<path class="${cls.join(' ')}" d="${d}"/><path class="edge-hit" data-edge="${esc(e.id)}" d="${d}"/>`;
    }
    if (temp) html += `<path class="edge temp" d="${curve(temp.from, temp.to)}"/>`;
    edgesEl.innerHTML = html;
  }

  function latestLogs() {
    const map = {};
    if (S.exec) for (const l of S.exec.logs) map[l.node_id] = l;
    return map;
  }
  function executedEdges() {
    const set = new Set();
    if (!S.exec) return set;
    const logs = latestLogs();
    for (const e of S.wf.edges) {
      if (logs[e.source] && logs[e.source].status === 'success' && logs[e.target]) {
        // for branching nodes only the taken branch counts
        const out = logs[e.source].output_data;
        const def = typeByKey[(nodeById(e.source) || {}).type];
        if (def && def.outputs.length > 1 && out && typeof out.conditionResult === 'boolean') {
          if (String(out.conditionResult) !== e.sourceHandle) continue;
        }
        set.add(e.id);
      }
    }
    return set;
  }

  function applySelectionClasses() {
    nodesEl.querySelectorAll('.node').forEach((el) =>
      el.classList.toggle('selected', !!S.sel && S.sel.kind === 'node' && S.sel.id === el.dataset.id));
  }
  function applyExecutionClasses() {
    const logs = latestLogs();
    nodesEl.querySelectorAll('.node').forEach((el) => {
      el.classList.remove('st-running', 'st-success', 'st-error', 'st-skipped');
      if (!S.exec) return;
      const l = logs[el.dataset.id];
      el.classList.add(l ? `st-${l.status}` : 'st-skipped');
    });
    renderEdges();
  }

  function select(sel) {
    S.sel = sel;
    applySelectionClasses();
    renderEdges();
    renderPanel();
  }

  // ---------- mouse interaction ----------
  let drag = null;
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const outPort = ev.target.closest('.port.out');
    const nodeEl = ev.target.closest('.node');
    const edgeHit = ev.target.closest('.edge-hit');
    if (outPort) {
      const id = outPort.closest('.node').dataset.id;
      drag = { kind: 'connect', source: id, handle: outPort.dataset.handle, from: portPos(id, outPort.dataset.handle, false) };
      ev.preventDefault();
    } else if (nodeEl) {
      const n = nodeById(nodeEl.dataset.id);
      select({ kind: 'node', id: n.id });
      drag = { kind: 'node', id: n.id, el: nodeEl, startX: ev.clientX, startY: ev.clientY, ox: n.x, oy: n.y, moved: false };
      ev.preventDefault();
    } else if (edgeHit) {
      select({ kind: 'edge', id: edgeHit.dataset.edge });
      ev.preventDefault();
    } else {
      select(null);
      drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, ox: S.view.x, oy: S.view.y };
      canvas.classList.add('panning');
      ev.preventDefault();
    }
  });
  const onMove = (ev) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      S.view.x = drag.ox + ev.clientX - drag.startX;
      S.view.y = drag.oy + ev.clientY - drag.startY;
      applyView();
    } else if (drag.kind === 'node') {
      const n = nodeById(drag.id);
      const nx = Math.round(drag.ox + (ev.clientX - drag.startX) / S.view.z);
      const ny = Math.round(drag.oy + (ev.clientY - drag.startY) / S.view.z);
      if (nx !== n.x || ny !== n.y) drag.moved = true;
      n.x = nx; n.y = ny;
      drag.el.style.left = nx + 'px'; drag.el.style.top = ny + 'px';
      renderEdges();
    } else if (drag.kind === 'connect') {
      const p = toWorld(ev.clientX, ev.clientY);
      renderEdges({ from: drag.from, to: p });
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      nodesEl.querySelectorAll('.port.in.hot').forEach((x) => x.classList.remove('hot'));
      const target = over && over.closest('.node');
      if (target && target.dataset.id !== drag.source) {
        const inPort = target.querySelector('.port.in');
        if (inPort) inPort.classList.add('hot');
      }
    }
  };
  const onUp = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.classList.remove('panning');
    nodesEl.querySelectorAll('.port.in.hot').forEach((x) => x.classList.remove('hot'));
    if (d.kind === 'node' && d.moved) markDirty();
    if (d.kind === 'connect') {
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = over && over.closest('.node');
      if (target) addEdge(d.source, d.handle, target.dataset.id);
      renderEdges();
    }
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  const onKey = (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelection(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); save(); }
  };
  window.addEventListener('keydown', onKey);
  const onBeforeUnload = (ev) => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---------- config panel ----------
  function renderPanel() {
    const panel = $('#panel');
    if (!S.sel || S.sel.kind !== 'node') {
      panel.innerHTML = S.sel
        ? '<h3>Connection</h3><p class="desc">Press <b>Delete</b> to remove this connection.</p><button class="danger" id="del-sel">Delete connection</button>'
        : '<h3>Settings</h3><p class="desc">Select a node to configure it.</p><div class="note">Use <code>{{ name }}</code> in any text field to insert data from the previous node, e.g. <code>{{ data.title }}</code>. Run the workflow once and select a node to see which fields are available.</div>' +
          `<div class="field"><label>Description</label><textarea id="wf-desc" placeholder="What does this workflow do?">${esc(S.wf.description || '')}</textarea></div>`;
      const d = $('#del-sel'); if (d) d.onclick = deleteSelection;
      const wd = $('#wf-desc'); if (wd) wd.oninput = () => { S.wf.description = wd.value; markDirty(); };
      return;
    }
    const n = nodeById(S.sel.id);
    const def = typeByKey[n.type];
    const logs = latestLogs();
    const lastInput = logs[n.id] && logs[n.id].input_data;
    const keys = lastInput && typeof lastInput === 'object' ? Object.keys(lastInput) : [];

    let html = `<h3>${esc(def.label)}</h3><p class="desc">${esc(def.description)}</p>
      <div class="field"><label>Node name</label><input id="cfg-label" value="${esc(n.label || '')}" placeholder="${esc(def.label)}" /></div>`;

    if (n.type === 'webhook') {
      const url = `${location.origin}/webhook/${S.wf.id}/${n.id}`;
      html += `<div class="note">Webhook URL (GET or POST):<br><code>${esc(url)}</code><br>The workflow must be <b>Active</b>. Payload fields are available as <code>{{ body.x }}</code> and <code>{{ query.x }}</code>.</div>`;
    }
    if (n.type === 'schedule') {
      html += '<div class="note">Runs only while the workflow is <b>Active</b> (toggle at the top). Times use the server\'s timezone.</div>';
    }
    for (const f of def.fields) {
      const val = n.config[f.name] ?? '';
      let input;
      if (f.type === 'select') {
        input = `<select data-f="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea data-f="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
      } else {
        input = `<input data-f="${f.name}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" />`;
      }
      html += `<div class="field"><label>${esc(f.label)}</label>${input}</div>`;
    }
    if (keys.length) {
      html += `<div class="field"><label>Data this node received (last run)</label><div class="chips">${keys.map((k) => `<span class="chip">{{ ${esc(k)} }}</span>`).join('')}</div></div>`;
    }
    html += '<div class="row"><button id="dup-node">Duplicate</button><button class="danger" id="del-node">Delete</button></div>';
    panel.innerHTML = html;

    $('#cfg-label').oninput = (ev) => {
      n.label = ev.target.value.trim() || undefined;
      const t = nodesEl.querySelector(`.node[data-id="${n.id}"] .title`);
      if (t) t.textContent = n.label || def.label;
      markDirty();
    };
    panel.querySelectorAll('[data-f]').forEach((el) => {
      const handler = () => {
        const f = def.fields.find((x) => x.name === el.dataset.f);
        n.config[f.name] = f.type === 'number' && el.value !== '' ? Number(el.value) : el.value;
        markDirty();
      };
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
    $('#dup-node').onclick = () => duplicateNode(n.id);
    $('#del-node').onclick = deleteSelection;
  }

  // ---------- save / run / activate ----------
  async function save() {
    const name = $('#wf-name').value.trim();
    if (!name) { toast('Workflow name is required', 'error'); return false; }
    try {
      $('#save-status').textContent = 'Saving...';
      const saved = await api('PUT', `/api/workflows/${S.wf.id}`, { name, description: S.wf.description, nodes: S.wf.nodes, edges: S.wf.edges });
      S.wf.name = saved.name;
      S.dirty = false;
      $('#save-status').textContent = 'Saved';
      return true;
    } catch (e) {
      $('#save-status').textContent = 'Unsaved';
      toast(`Save failed: ${e.message}`, 'error');
      return false;
    }
  }
  $('#save').onclick = async () => { if (await save()) toast('Workflow saved', 'success'); };
  $('#wf-name').oninput = markDirty;
  $('#back').onclick = () => {
    if (S.dirty && !confirm('You have unsaved changes. Leave anyway?')) return;
    S.dirty = false;
    location.hash = '#/';
  };
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ name: $('#wf-name').value, description: S.wf.description, nodes: S.wf.nodes, edges: S.wf.edges }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${($('#wf-name').value || 'workflow').replace(/[^\w-]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#active').onchange = async (ev) => {
    const want = ev.target.checked;
    if (!(await save())) { ev.target.checked = !want; return; }
    try {
      const w = await api('POST', `/api/workflows/${S.wf.id}/activate`, { active: want });
      S.wf.active = w.active;
      toast(want ? 'Active: schedule and webhook triggers are now live' : 'Workflow deactivated', 'success');
    } catch (e) { ev.target.checked = !want; toast(e.message, 'error'); }
  };

  $('#run').onclick = async () => {
    if (S.running) return;
    if (!S.wf.nodes.length) return toast('Add some nodes first', 'error');
    if (!(await save())) return;
    try {
      const { executionId } = await api('POST', `/api/workflows/${S.wf.id}/run`);
      S.running = true;
      $('#run').disabled = true;
      S.exec = { id: executionId, status: 'running', logs: [] };
      setTab('logs');
      applyExecutionClasses();
      poll(executionId, true);
    } catch (e) { toast(e.message, 'error'); }
  };

  function poll(id, announce) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(async () => {
      try {
        const ex = await api('GET', `/api/executions/${id}`);
        S.exec = ex;
        applyExecutionClasses();
        renderBottom();
        if (S.sel && S.sel.kind === 'node') renderPanelKeepFocus();
        if (ex.status === 'running') return poll(id, announce);
        S.running = false;
        $('#run').disabled = false;
        if (announce) toast(ex.status === 'success' ? 'Execution finished successfully' : `Execution failed: ${ex.error}`, ex.status === 'success' ? 'success' : 'error');
        loadHistory();
      } catch (e) {
        S.running = false; $('#run').disabled = false;
        toast(e.message, 'error');
      }
    }, 350);
  }
  function renderPanelKeepFocus() {
    // Only refresh the "data available" chips; avoid wiping what the user is typing.
    if (document.activeElement && $('#panel').contains(document.activeElement)) return;
    renderPanel();
  }

  // ---------- bottom panel ----------
  function setTab(t) {
    S.tab = t;
    document.querySelectorAll('.tab[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (S.collapsed) { S.collapsed = false; $('#bottom').classList.remove('collapsed'); $('#collapse').textContent = 'Hide ▾'; }
    renderBottom();
  }
  document.querySelectorAll('.tab[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('#collapse').onclick = () => {
    S.collapsed = !S.collapsed;
    $('#bottom').classList.toggle('collapsed', S.collapsed);
    $('#collapse').textContent = S.collapsed ? 'Show ▴' : 'Hide ▾';
  };

  function renderBottom() {
    const body = $('#bottom-body');
    if (S.tab === 'history') {
      body.innerHTML = S.history.length
        ? `<table class="table"><thead><tr><th>#</th><th>Status</th><th>Trigger</th><th>Started</th><th>Duration</th></tr></thead><tbody>${S.history.map((r) =>
            `<tr data-ex="${r.id}"><td>${r.id}</td><td>${badge(r.status)}</td><td>${esc(r.trigger)}</td><td>${esc(fmtDate(r.started_at))}</td><td>${fmtDuration(r.started_at, r.completed_at)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No executions yet. Click Run.</div>';
      return;
    }
    if (!S.exec) { body.innerHTML = '<div class="empty">Click ▶ Run to execute this workflow. Each node\'s input and output will appear here.</div>'; return; }
    const ex = S.exec;
    const pretty = (v) => esc(v === null || v === undefined ? '-' : JSON.stringify(v, null, 2));
    body.innerHTML = `
      <div class="exec-head"><b>Execution #${ex.id}</b> ${badge(ex.status)}
        ${ex.started_at ? `<span>${esc(ex.trigger || '')} · ${esc(fmtDate(ex.started_at))} · ${fmtDuration(ex.started_at, ex.completed_at)}</span>` : ''}</div>
      ${ex.error ? `<div class="err" style="padding:0 0 8px">${esc(ex.error)}</div>` : ''}
      ${ex.logs.map((l) => `
        <details class="log" data-log="${l.id}" ${S.openLogs.has(l.id) ? 'open' : ''}>
          <summary data-node="${esc(l.node_id)}"><span class="dot ${esc(l.status)}"></span><b>${esc(l.node_label || l.node_type)}</b>
            <span style="color:var(--muted)">${esc(l.status)} ${fmtDuration(l.started_at, l.completed_at)}</span></summary>
          <div class="body">
            <div><div class="lbl">INPUT</div><pre>${pretty(l.input_data)}</pre></div>
            <div><div class="lbl">OUTPUT</div><pre>${pretty(l.output_data)}</pre></div>
            ${l.error_message ? `<div class="err">${esc(l.error_message)}</div>` : ''}
          </div>
        </details>`).join('') || '<div class="empty">Starting...</div>'}`;
  }
  $('#bottom-body').addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.dataset && d.dataset.log) { const id = Number(d.dataset.log); d.open ? S.openLogs.add(id) : S.openLogs.delete(id); }
  }, true);
  $('#bottom-body').addEventListener('click', async (ev) => {
    const row = ev.target.closest('tr[data-ex]');
    if (row) {
      const ex = await api('GET', `/api/executions/${row.dataset.ex}`);
      S.exec = ex; S.openLogs.clear();
      applyExecutionClasses(); setTab('logs');
      if (ex.status === 'running') { S.running = true; $('#run').disabled = true; poll(ex.id, false); }
      return;
    }
    const sum = ev.target.closest('summary[data-node]');
    if (sum && nodeById(sum.dataset.node)) select({ kind: 'node', id: sum.dataset.node });
  });

  async function loadHistory() {
    try { S.history = await api('GET', `/api/workflows/${S.wf.id}/executions`); } catch { /* ignore */ }
    if (S.tab === 'history') renderBottom();
  }

  // ---------- init ----------
  renderGraph();
  renderPanel();
  applyView();
  requestAnimationFrame(fitView);
  await loadHistory();
  if (execId) {
    try {
      S.exec = await api('GET', `/api/executions/${execId}`);
      applyExecutionClasses();
    } catch { /* ignore */ }
  }
  renderBottom();

  teardown = () => {
    clearTimeout(S.pollTimer);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
}
