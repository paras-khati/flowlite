/**
 * Node library.
 *
 * EVERY node follows the same interface:
 *
 *   {
 *     type, label, category, description,
 *     fields:   [...]   // describes the config form shown in the UI
 *     defaults: {...}   // default config values
 *     outputs:  ['out'] // output handles ('true'/'false' for branching nodes)
 *     execute({ config, input, vars, context }) -> { output, branch? }
 *   }
 *
 * - `input`  is the output of the previous node.
 * - `output` is passed to the next node(s).
 * - `branch` (optional) selects which output handle to follow.
 *
 * Adding a new node = add one object to this list. The engine never changes.
 */

// ---------- helpers ----------

function getPath(obj, pathStr) {
  if (!pathStr) return obj;
  return pathStr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Replace {{ path }} with values. Paths look like `input.data.title` or `vars.name`. */
function render(template, scope) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    let value = getPath(scope, expr);
    if (value === undefined && !/^(input|vars)\b/.test(expr)) value = getPath(scope.input, expr);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** If the whole template is a single {{ expr }}, return the raw value (keeps numbers/objects). */
function resolve(template, scope) {
  if (typeof template !== 'string') return template;
  const m = template.match(/^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (m) {
    let value = getPath(scope, m[1]);
    if (value === undefined && !/^(input|vars)\b/.test(m[1])) value = getPath(scope.input, m[1]);
    return value;
  }
  return render(template, scope);
}

function scopeOf({ input, vars }) {
  return { input, vars };
}

function parseJson(text, label) {
  if (!text || !String(text).trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
}

// Basic SSRF guard (literal hostnames only). Set FLOWLITE_ALLOW_PRIVATE=1 to disable.
function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: "${urlStr}"`);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (process.env.FLOWLITE_ALLOW_PRIVATE === '1') return u;
  const h = u.hostname.toLowerCase();
  const privateHost =
    h === 'localhost' || h.endsWith('.local') || h === '[::1]' || h === '0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (privateHost) {
    throw new Error('Requests to local/private addresses are blocked (set FLOWLITE_ALLOW_PRIVATE=1 to allow)');
  }
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- node definitions ----------

const nodes = [
  // ===== Triggers =====
  {
    type: 'manualTrigger',
    label: 'Manual Trigger',
    category: 'Triggers',
    description: 'Starts the workflow when you click Run.',
    isTrigger: true,
    fields: [],
    defaults: {},
    outputs: ['out'],
    async execute() {
      return { output: { triggeredAt: new Date().toISOString(), trigger: 'manual' } };
    },
  },
  {
    type: 'webhook',
    label: 'Webhook',
    category: 'Triggers',
    description: 'Starts the workflow when an external app calls its URL (workflow must be Active).',
    isTrigger: true,
    fields: [],
    defaults: {},
    outputs: ['out'],
    async execute({ context }) {
      // When started by an HTTP call, the payload is provided by the engine.
      return { output: context.triggerData || { body: {}, query: {}, note: 'Run manually - no webhook payload' } };
    },
  },
  {
    type: 'schedule',
    label: 'Schedule Trigger',
    category: 'Triggers',
    description: 'Runs the workflow on a schedule (workflow must be Active).',
    isTrigger: true,
    fields: [
      {
        name: 'mode', label: 'Run', type: 'select',
        options: [
          { value: 'everyMinute', label: 'Every minute' },
          { value: 'everyHour', label: 'Every hour' },
          { value: 'everyDay', label: 'Every day (09:00)' },
          { value: 'custom', label: 'Custom cron expression' },
        ],
      },
      { name: 'cron', label: 'Cron expression (custom only)', type: 'text', placeholder: '*/5 * * * *' },
    ],
    defaults: { mode: 'everyMinute', cron: '*/5 * * * *' },
    outputs: ['out'],
    async execute() {
      return { output: { triggeredAt: new Date().toISOString(), trigger: 'schedule' } };
    },
  },

  // ===== Data =====
  {
    type: 'setVariable',
    label: 'Set Variable',
    category: 'Data',
    description: 'Creates a variable. Value can use {{ templates }}.',
    fields: [
      { name: 'name', label: 'Variable name', type: 'text', placeholder: 'title' },
      { name: 'value', label: 'Value', type: 'text', placeholder: '{{ data.title }}' },
    ],
    defaults: { name: 'myVar', value: '' },
    outputs: ['out'],
    async execute({ config, input, vars }) {
      if (!config.name) throw new Error('Variable name is required');
      const value = resolve(config.value, scopeOf({ input, vars }));
      vars[config.name] = value;
      const base = input && typeof input === 'object' && !Array.isArray(input) ? input : { input };
      return { output: { ...base, [config.name]: value } };
    },
  },
  {
    type: 'textFormatter',
    label: 'Text Formatter',
    category: 'Data',
    description: 'Builds or transforms text.',
    fields: [
      { name: 'text', label: 'Text', type: 'textarea', placeholder: 'Hello {{ name }}' },
      {
        name: 'operation', label: 'Operation', type: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'uppercase', label: 'UPPERCASE' },
          { value: 'lowercase', label: 'lowercase' },
          { value: 'trim', label: 'Trim spaces' },
        ],
      },
    ],
    defaults: { text: '', operation: 'none' },
    outputs: ['out'],
    async execute({ config, input, vars }) {
      let text = render(config.text, scopeOf({ input, vars }));
      if (config.operation === 'uppercase') text = text.toUpperCase();
      if (config.operation === 'lowercase') text = text.toLowerCase();
      if (config.operation === 'trim') text = text.trim();
      return { output: { text } };
    },
  },

  // ===== Logic =====
  {
    type: 'condition',
    label: 'Condition (IF)',
    category: 'Logic',
    description: 'Branches to TRUE or FALSE.',
    fields: [
      { name: 'left', label: 'Value', type: 'text', placeholder: '{{ status }}' },
      {
        name: 'operator', label: 'Operator', type: 'select',
        options: [
          { value: 'equals', label: 'equals' },
          { value: 'notEquals', label: 'does not equal' },
          { value: 'contains', label: 'contains' },
          { value: 'gt', label: 'greater than' },
          { value: 'gte', label: 'greater or equal' },
          { value: 'lt', label: 'less than' },
          { value: 'lte', label: 'less or equal' },
          { value: 'exists', label: 'is not empty' },
        ],
      },
      { name: 'right', label: 'Compare to', type: 'text', placeholder: '200' },
    ],
    defaults: { left: '', operator: 'equals', right: '' },
    outputs: ['true', 'false'],
    async execute({ config, input, vars }) {
      const scope = scopeOf({ input, vars });
      const left = resolve(config.left, scope);
      const right = resolve(config.right, scope);
      const ls = String(left ?? '');
      const rs = String(right ?? '');
      const ln = Number(left);
      const rn = Number(right);
      let result;
      switch (config.operator) {
        case 'equals': result = ls === rs; break;
        case 'notEquals': result = ls !== rs; break;
        case 'contains': result = ls.includes(rs); break;
        case 'gt': result = ln > rn; break;
        case 'gte': result = ln >= rn; break;
        case 'lt': result = ln < rn; break;
        case 'lte': result = ln <= rn; break;
        case 'exists': result = ls.length > 0; break;
        default: throw new Error(`Unknown operator: ${config.operator}`);
      }
      return {
        output: { ...(typeof input === 'object' && input ? input : { input }), conditionResult: result },
        branch: result ? 'true' : 'false',
      };
    },
  },

  // ===== API =====
  {
    type: 'httpRequest',
    label: 'HTTP Request',
    category: 'API',
    description: 'Calls an external API. Response is available as {{ status }} and {{ data }}.',
    fields: [
      {
        name: 'method', label: 'Method', type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m })),
      },
      { name: 'url', label: 'URL', type: 'text', placeholder: 'https://jsonplaceholder.typicode.com/todos/1' },
      { name: 'headers', label: 'Headers (JSON)', type: 'textarea', placeholder: '{"Authorization": "Bearer ..."}' },
      { name: 'body', label: 'Body (JSON, for POST/PUT)', type: 'textarea', placeholder: '{"name": "{{ name }}"}' },
    ],
    defaults: { method: 'GET', url: '', headers: '', body: '' },
    outputs: ['out'],
    async execute({ config, input, vars }) {
      const scope = scopeOf({ input, vars });
      const url = render(config.url, scope).trim();
      if (!url) throw new Error('URL is required');
      assertPublicUrl(url);
      const method = (config.method || 'GET').toUpperCase();
      const headers = parseJson(render(config.headers, scope), 'Headers') || {};
      const options = { method, headers, signal: AbortSignal.timeout(15000) };
      if (!['GET', 'HEAD'].includes(method) && config.body && config.body.trim()) {
        const bodyText = render(config.body, scope);
        parseJson(bodyText, 'Body');
        options.body = bodyText;
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
      const res = await fetch(url, options);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.slice(0, 50000); }
      return { output: { status: res.status, ok: res.ok, data } };
    },
  },

  // ===== Utilities =====
  {
    type: 'delay',
    label: 'Delay',
    category: 'Utilities',
    description: 'Waits before continuing (max 30 seconds).',
    fields: [{ name: 'seconds', label: 'Seconds', type: 'number', placeholder: '2' }],
    defaults: { seconds: 2 },
    outputs: ['out'],
    async execute({ config, input }) {
      const s = Math.min(Math.max(Number(config.seconds) || 0, 0), 30);
      await sleep(s * 1000);
      return { output: input };
    },
  },
  {
    type: 'randomNumber',
    label: 'Random Number',
    category: 'Utilities',
    description: 'Generates a random integer. Available as {{ random }}.',
    fields: [
      { name: 'min', label: 'Min', type: 'number' },
      { name: 'max', label: 'Max', type: 'number' },
    ],
    defaults: { min: 1, max: 100 },
    outputs: ['out'],
    async execute({ config }) {
      const min = Math.ceil(Number(config.min));
      const max = Math.floor(Number(config.max));
      if (Number.isNaN(min) || Number.isNaN(max) || max < min) throw new Error('Invalid min/max');
      return { output: { random: Math.floor(Math.random() * (max - min + 1)) + min } };
    },
  },

  // ===== Communication =====
  {
    type: 'email',
    label: 'Send Email',
    category: 'Communication',
    description: 'Sends a real email if SMTP_USER and SMTP_PASS are set in the .env file; otherwise it is simulated (logged only).',
    fields: [
      { name: 'to', label: 'To', type: 'text', placeholder: 'me@example.com' },
      { name: 'subject', label: 'Subject', type: 'text', placeholder: 'Site is down!' },
      { name: 'body', label: 'Body', type: 'textarea', placeholder: 'Status was {{ status }}' },
    ],
    defaults: { to: '', subject: '', body: '' },
    outputs: ['out'],
    async execute({ config, input, vars }) {
      const scope = scopeOf({ input, vars });
      const to = render(config.to, scope).trim();
      if (!to) throw new Error('Recipient (To) is required');
      const mail = { to, subject: render(config.subject, scope), body: render(config.body, scope) };

      const { SMTP_USER, SMTP_PASS } = process.env;
      if (!SMTP_USER || !SMTP_PASS) {
        // No credentials configured: simulate so workflows still run.
        console.log('[email:simulated]', JSON.stringify(mail));
        return { output: { sent: true, simulated: true, ...mail } };
      }

      const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
      if (recipients.length > 5) throw new Error('Too many recipients (max 5)');
      const bad = recipients.find((r) => !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(r));
      if (bad) throw new Error(`"${bad}" is not a valid email address`);

      const port = Number(process.env.SMTP_PORT || 465);
      const transporter = require('nodemailer').createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port,
        secure: port === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
      });
      try {
        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM || SMTP_USER,
          to: recipients.join(', '),
          subject: mail.subject,
          text: mail.body,
        });
        console.log(`[email:sent] to=${mail.to} id=${info.messageId}`);
        return { output: { sent: true, simulated: false, messageId: info.messageId, ...mail } };
      } catch (err) {
        // Never echo credentials; surface a clear, short reason.
        const hint = err.responseCode === 535 || /Invalid login|Username and Password/i.test(err.message)
          ? ' (login rejected: check SMTP_USER and that SMTP_PASS is a Gmail App Password, not your normal password)'
          : '';
        throw new Error(`Email failed: ${err.message}${hint}`);
      }
    },
  },

  // ===== Output =====
  {
    type: 'display',
    label: 'Display',
    category: 'Output',
    description: 'Shows a value in the execution log.',
    fields: [{ name: 'value', label: 'Value to display', type: 'textarea', placeholder: '{{ data }}' }],
    defaults: { value: '{{ input }}' },
    outputs: ['out'],
    async execute({ config, input, vars }) {
      const value = resolve(config.value, scopeOf({ input, vars }));
      return { output: { display: value } };
    },
  },
  {
    type: 'stop',
    label: 'Stop',
    category: 'Output',
    description: 'Ends this branch of the workflow.',
    fields: [],
    defaults: {},
    outputs: [],
    async execute({ input }) {
      return { output: input };
    },
  },
];

const registry = Object.fromEntries(nodes.map((n) => [n.type, n]));

/** Public metadata for the frontend (no functions). */
function nodeTypesMeta() {
  return nodes.map(({ execute, ...meta }) => meta);
}

module.exports = { registry, nodeTypesMeta, render, resolve };
