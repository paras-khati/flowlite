/** Prebuilt workflows users can import with one click. */
const n = (id, type, x, y, config = {}, label) => ({ id, type, x, y, config, ...(label ? { label } : {}) });
const e = (source, target, sourceHandle = 'out') => ({ id: `${source}-${sourceHandle}-${target}`, source, target, sourceHandle });

module.exports = [
  {
    key: 'api-fetch',
    name: 'API data fetching (MVP demo)',
    description: 'Fetch a todo from a public API, store its title, and branch on whether it is completed.',
    nodes: [
      n('n1', 'manualTrigger', 60, 160),
      n('n2', 'httpRequest', 300, 160, { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos/1', headers: '', body: '' }),
      n('n3', 'setVariable', 540, 160, { name: 'title', value: '{{ data.title }}' }),
      n('n4', 'condition', 780, 160, { left: '{{ data.completed }}', operator: 'equals', right: 'false' }),
      n('n5', 'display', 1040, 80, { value: 'Not completed yet: {{ title }}' }, 'Display (TRUE)'),
      n('n6', 'stop', 1040, 260, {}, 'Stop (FALSE)'),
    ],
    edges: [e('n1', 'n2'), e('n2', 'n3'), e('n3', 'n4'), e('n4', 'n5', 'true'), e('n4', 'n6', 'false')],
  },
  {
    key: 'uptime',
    name: 'Website uptime monitoring',
    description: 'Every minute: check a URL and send an email if it does not return 200. Activate it to start.',
    nodes: [
      n('n1', 'schedule', 60, 160, { mode: 'everyMinute', cron: '* * * * *' }),
      n('n2', 'httpRequest', 300, 160, { method: 'GET', url: 'https://example.com', headers: '', body: '' }),
      n('n3', 'condition', 540, 160, { left: '{{ status }}', operator: 'equals', right: '200' }, 'Check Status'),
      n('n4', 'stop', 800, 80, {}, 'Stop (site is up)'),
      n('n5', 'email', 800, 260, { to: 'you@example.com', subject: 'Site is down!', body: 'Status code was {{ status }}' }),
    ],
    edges: [e('n1', 'n2'), e('n2', 'n3'), e('n3', 'n4', 'true'), e('n3', 'n5', 'false')],
  },
  {
    key: 'webhook-echo',
    name: 'Webhook receiver',
    description: 'Receives JSON from any app (e.g. a form) and shows it. Activate, then POST to the webhook URL.',
    nodes: [
      n('n1', 'webhook', 60, 140),
      n('n2', 'setVariable', 300, 140, { name: 'name', value: '{{ body.name }}' }),
      n('n3', 'textFormatter', 540, 140, { text: 'New submission from {{ name }}', operation: 'none' }),
      n('n4', 'display', 780, 140, { value: '{{ text }}' }),
    ],
    edges: [e('n1', 'n2'), e('n2', 'n3'), e('n3', 'n4')],
  },
  {
    key: 'random-branch',
    name: 'Random number high/low',
    description: 'Generates a number 1-100 and branches on whether it is above 50. No internet needed.',
    nodes: [
      n('n1', 'manualTrigger', 60, 160),
      n('n2', 'randomNumber', 300, 160, { min: 1, max: 100 }),
      n('n3', 'condition', 540, 160, { left: '{{ random }}', operator: 'gt', right: '50' }),
      n('n4', 'textFormatter', 800, 80, { text: '{{ random }} is HIGH', operation: 'none' }),
      n('n5', 'textFormatter', 800, 260, { text: '{{ random }} is LOW', operation: 'none' }),
    ],
    edges: [e('n1', 'n2'), e('n2', 'n3'), e('n3', 'n4', 'true'), e('n3', 'n5', 'false')],
  },
  {
    key: 'weather',
    name: 'Weather notification',
    description: 'Gets current temperature from Open-Meteo (no API key) and emails you if it is hot. Edit the coordinates.',
    nodes: [
      n('n1', 'manualTrigger', 60, 160),
      n('n2', 'httpRequest', 300, 160, {
        method: 'GET',
        url: 'https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current_weather=true',
        headers: '', body: '',
      }),
      n('n3', 'setVariable', 540, 160, { name: 'temp', value: '{{ data.current_weather.temperature }}' }),
      n('n4', 'condition', 780, 160, { left: '{{ temp }}', operator: 'gt', right: '25' }, 'Hot?'),
      n('n5', 'email', 1040, 80, { to: 'you@example.com', subject: 'It is hot!', body: 'Temperature is {{ temp }} C' }),
      n('n6', 'stop', 1040, 260),
    ],
    edges: [e('n1', 'n2'), e('n2', 'n3'), e('n3', 'n4'), e('n4', 'n5', 'true'), e('n4', 'n6', 'false')],
  },
  {
    key: 'reminder',
    name: 'Scheduled reminder',
    description: 'Every day at 09:00 build a reminder message and email it. Activate to start.',
    nodes: [
      n('n1', 'schedule', 60, 140, { mode: 'everyDay', cron: '0 9 * * *' }),
      n('n2', 'textFormatter', 300, 140, { text: 'Reminder: stand-up at 10:00 (sent {{ triggeredAt }})', operation: 'none' }),
      n('n3', 'email', 540, 140, { to: 'you@example.com', subject: 'Daily reminder', body: '{{ text }}' }),
    ],
    edges: [e('n1', 'n2'), e('n2', 'n3')],
  },
];
