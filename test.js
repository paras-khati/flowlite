// End-to-end test: runs the server in-process and exercises the MVP workflow.
process.env.FLOWLITE_DB = ':memory:';
process.env.FLOWLITE_ALLOW_PRIVATE = '1';
const http = require('http');
const app = require('./server');

const server = http.createServer(app).listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  const wait = async (id) => {
    for (let i = 0; i < 50; i++) {
      const { data } = await api('GET', `/api/executions/${id}`);
      if (data.status !== 'running') return data;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout');
  };
  let failures = 0;
  const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${ok ? '' : extra}`); if (!ok) failures++; };

  // 1. local "API" to call so the test needs no internet
  const mock = http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ title: 'hello', completed: false })); }).listen(0);
  const mockUrl = `http://127.0.0.1:${mock.address().port}/todo`;

  // 2. MVP workflow
  const wf = {
    name: 'MVP',
    nodes: [
      { id: 'n1', type: 'manualTrigger' },
      { id: 'n2', type: 'httpRequest', config: { method: 'GET', url: mockUrl } },
      { id: 'n3', type: 'setVariable', config: { name: 'title', value: '{{ data.title }}' } },
      { id: 'n4', type: 'condition', config: { left: '{{ data.completed }}', operator: 'equals', right: 'false' } },
      { id: 'n5', type: 'display', config: { value: 'Todo: {{ title }}' } },
      { id: 'n6', type: 'stop' },
    ],
    edges: [
      { source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' }, { source: 'n3', target: 'n4' },
      { source: 'n4', target: 'n5', sourceHandle: 'true' }, { source: 'n4', target: 'n6', sourceHandle: 'false' },
    ],
  };
  const created = await api('POST', '/api/workflows', wf);
  check('create workflow', created.status === 201);
  const id = created.data.id;

  const run = await api('POST', `/api/workflows/${id}/run`);
  const ex = await wait(run.data.executionId);
  check('execution succeeds', ex.status === 'success', JSON.stringify(ex));
  const ran = ex.logs.map((l) => l.node_id);
  check('TRUE branch executed, FALSE branch skipped', ran.join() === 'n1,n2,n3,n4,n5', ran.join());
  check('HTTP output captured', ex.logs[1].output_data.status === 200 && ex.logs[1].output_data.data.title === 'hello');
  check('template resolved in Display', ex.logs[4].output_data.display === 'Todo: hello', JSON.stringify(ex.logs[4].output_data));

  // 3. error handling
  const bad = await api('POST', '/api/workflows', { name: 'bad', nodes: [{ id: 'a', type: 'manualTrigger' }, { id: 'b', type: 'httpRequest', config: { url: '' } }], edges: [{ source: 'a', target: 'b' }] });
  const ex2 = await wait((await api('POST', `/api/workflows/${bad.data.id}/run`)).data.executionId);
  check('failure is recorded', ex2.status === 'failed' && /URL is required/.test(ex2.error) && ex2.logs[1].status === 'error', JSON.stringify(ex2));

  // 4. SSRF guard
  process.env.FLOWLITE_ALLOW_PRIVATE = '0';
  const ex3 = await wait((await api('POST', `/api/workflows/${id}/run`)).data.executionId);
  check('private addresses blocked by default', ex3.status === 'failed' && /blocked/.test(ex3.error), ex3.error);
  process.env.FLOWLITE_ALLOW_PRIVATE = '1';

  // 5. webhook
  const hook = await api('POST', '/api/workflows', {
    name: 'hook',
    nodes: [{ id: 'w', type: 'webhook' }, { id: 'd', type: 'display', config: { value: 'hi {{ body.name }}' } }],
    edges: [{ source: 'w', target: 'd' }],
  });
  const inactive = await api('POST', `/webhook/${hook.data.id}/w`, { name: 'Ana' });
  check('inactive webhook rejected', inactive.status === 409);
  await api('POST', `/api/workflows/${hook.data.id}/activate`, { active: true });
  const fired = await api('POST', `/webhook/${hook.data.id}/w`, { name: 'Ana' });
  const ex4 = await wait(fired.data.executionId);
  check('webhook triggers workflow', ex4.status === 'success' && ex4.logs[1].output_data.display === 'hi Ana', JSON.stringify(ex4.logs));

  // 5b. scheduling (6-field cron = every 2 seconds, so the test is fast)
  const sched = await api('POST', '/api/workflows', {
    name: 'sched',
    nodes: [{ id: 's', type: 'schedule', config: { mode: 'custom', cron: '*/2 * * * * *' } }, { id: 'd', type: 'display', config: { value: '{{ trigger }}' } }],
    edges: [{ source: 's', target: 'd' }],
  });
  await api('POST', `/api/workflows/${sched.data.id}/activate`, { active: true });
  await new Promise((r) => setTimeout(r, 5500));
  const runs = (await api('GET', `/api/workflows/${sched.data.id}/executions`)).data;
  check('schedule trigger fires repeatedly while active', runs.length >= 2 && runs.every((r) => r.trigger === 'schedule'), `runs=${runs.length}`);
  await api('POST', `/api/workflows/${sched.data.id}/activate`, { active: false });
  await new Promise((r) => setTimeout(r, 500));
  const before = (await api('GET', `/api/workflows/${sched.data.id}/executions`)).data.length;
  await new Promise((r) => setTimeout(r, 4500));
  const after = (await api('GET', `/api/workflows/${sched.data.id}/executions`)).data.length;
  check('schedule stops when deactivated', after === before, `${before} -> ${after}`);

  // 6. validation, duplicate, templates, stats
  check('validation rejects unknown node', (await api('POST', '/api/workflows', { name: 'x', nodes: [{ id: 'a', type: 'nope' }] })).status === 400);
  check('duplicate works', (await api('POST', `/api/workflows/${id}/duplicate`)).status === 201);
  const tpls = await api('GET', '/api/templates');
  const imp = await api('POST', `/api/templates/${tpls.data[3].key}/import`);
  const ex5 = await wait((await api('POST', `/api/workflows/${imp.data.id}/run`)).data.executionId);
  check('template (random branch) runs', ex5.status === 'success', JSON.stringify(ex5));
  const stats = await api('GET', '/api/stats');
  check('stats counts executions', stats.data.executions >= 5);
  check('search works', (await api('GET', '/api/workflows?q=MVP')).data.length >= 1);

  console.log(failures ? `\n${failures} FAILED` : '\nAll tests passed');
  mock.close(); server.close(); process.exit(failures ? 1 : 0);
});
