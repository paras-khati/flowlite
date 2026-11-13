# FlowLite - a mini n8n-style automation platform

Connect blocks visually, click Run, and watch each node execute. One Node.js server, one SQLite file, and a plain HTML/JS frontend - **no build step, no Docker, no Redis**.

## Run it

Requires Node.js 18+ (tested on 22).

```bash
npm install
npm start
# open http://localhost:3000
```

Run the tests: `npm test`

On the dashboard, click **Use template -> API data fetching (MVP demo)**, open it and press **Run**.

## What works

| Area | Status |
|---|---|
| Dashboard: create, search, duplicate, delete, import JSON, stats, recent runs | yes |
| Visual editor: drag from palette, connect, move, zoom/pan, delete, duplicate, config panel, export JSON | yes |
| Execution engine: sequential, IF/ELSE branching, data passing, error handling, loop + time limits | yes |
| Live run view: yellow running / green success / red failed / grey skipped, plus per-node input/output | yes |
| Execution history (per workflow) | yes |
| Schedule trigger (every minute/hour/day or custom cron) via node-cron | yes |
| Webhook trigger with unique URL per node | yes |
| 6 templates | yes |

### Nodes (12)

Manual Trigger, Webhook, Schedule Trigger, Set Variable, Text Formatter, Condition (IF), HTTP Request, Delay, Random Number, Send Email, Display, Stop.

### Real emails (optional)

Send Email works out of the box in **simulated** mode (it only logs the message). To send real emails with Gmail:

1. Turn on 2-step verification on your Google account, then create an **App Password** at https://myaccount.google.com/apppasswords (16 letters; not your normal password).
2. In the project folder, copy `.env.example` to a new file named `.env` and fill in `SMTP_USER` (your Gmail address) and `SMTP_PASS` (the App Password).
3. Restart with `npm start`. The server console prints `[email:sent]` for each real email.

Any other provider works too: set `SMTP_HOST` and `SMTP_PORT` in `.env`. Keep `.env` private: it is git-ignored and not included in the zip. Gmail limits sending to roughly 500 emails per day.

### Using data between nodes

Every node receives the previous node's output. In any text field use `{{ name }}`:

- HTTP Request outputs `status`, `ok`, `data` -> `{{ data.title }}`
- Set Variable adds a field to the data (`{{ title }}`) and is also stored as a variable
- Webhook payload -> `{{ body.email }}`, `{{ query.id }}`

Run the workflow once, then click a node: the panel lists the fields it received.

### Active workflows (schedules and webhooks)

Toggle **Active** at the top of the editor. Then:

- Schedule triggers run on their cron (server timezone).
- Webhooks respond at `POST/GET /webhook/<workflowId>/<nodeId>` (the exact URL is shown in the node's panel). Inactive workflows return 409.

```bash
curl -X POST http://localhost:3000/webhook/1/n1 -H "Content-Type: application/json" -d '{"name":"Ana"}'
```

## Project layout

```
server.js      Express REST API + webhook route + static files
db.js          SQLite schema (workflows, executions, execution_logs)
engine.js      Executes a workflow graph and logs every node
nodes.js       Node library - every node has the same interface
scheduler.js   node-cron scheduling for Active workflows
templates.js   Prebuilt workflows
public/        index.html, style.css, app.js (dashboard + editor)
test.js        Backend end-to-end tests
```

## Extending: add a node in ~15 lines

Add one object to the list in `nodes.js`. The engine and UI pick it up automatically (the config form is generated from `fields`).

```js
{
  type: 'jsonExtract', label: 'Get Field', category: 'Data',
  description: 'Reads one field from the incoming data.',
  fields: [{ name: 'path', label: 'Path', type: 'text', placeholder: 'data.title' }],
  defaults: { path: '' },
  outputs: ['out'],
  async execute({ config, input, vars, context }) {
    const value = config.path.split('.').reduce((o, k) => o?.[k], input);
    return { output: { value } };      // add `branch: 'true'` to choose an output handle
  },
}
```

- Real database/storage node: add a table in `db.js` and write to it in a new node.

## Deploying

This is one process plus one SQLite file, so any host that runs a long-lived Node server works (Render, Railway, Fly.io, a VPS). Note that scheduling needs the server to stay running, so avoid serverless hosts such as Vercel for the backend. Use a persistent disk and set `FLOWLITE_DB=/path/to/flowlite.db`. Environment variables: `PORT`, `FLOWLITE_DB`, `SMTP_USER`, `SMTP_PASS` (and optionally `SMTP_FROM`, `SMTP_HOST`, `SMTP_PORT`); on a host, set them in its dashboard instead of a `.env` file.

## Known limitations (deliberate, to keep it simple)

- **No login / users.** Anyone who can reach the server can use it. Put it behind a password or VPN before exposing it publicly.
- HTTP Request blocks localhost/private addresses by default (basic SSRF guard on literal hostnames; set `FLOWLITE_ALLOW_PRIVATE=1` to allow). It does not resolve DNS, so it is not a complete defence for a public deployment.
- Execution is sequential. If two branches converge on one node, that node runs once per incoming branch.
- Limits: 100 node runs and 2 minutes per execution; Delay max 30 s; 200 nodes per workflow.
- Desktop browsers only (mouse-based canvas, no touch gestures).
- Run progress uses polling (350 ms), not WebSockets.
