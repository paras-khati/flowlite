/** Runs Active workflows that contain a Schedule Trigger, using node-cron. */
const cron = require('node-cron');
const db = require('./db');
const { startExecution } = require('./engine');

let tasks = [];

function cronExpression(config = {}) {
  switch (config.mode) {
    case 'everyHour': return '0 * * * *';
    case 'everyDay': return '0 9 * * *';
    case 'custom': return (config.cron || '').trim();
    case 'everyMinute':
    default: return '* * * * *';
  }
}

function reschedule() {
  tasks.forEach((t) => t.stop());
  tasks = [];
  const rows = db.prepare('SELECT * FROM workflows WHERE active = 1').all();
  for (const row of rows) {
    const workflow = { ...row, nodes: JSON.parse(row.nodes), edges: JSON.parse(row.edges) };
    for (const node of workflow.nodes.filter((n) => n.type === 'schedule')) {
      const expr = cronExpression(node.config);
      if (!cron.validate(expr)) {
        console.warn(`[scheduler] workflow ${row.id}: invalid cron "${expr}" - skipped`);
        continue;
      }
      tasks.push(
        cron.schedule(expr, () => {
          // Re-read the workflow so edits made after activation are picked up.
          const fresh = db.prepare('SELECT * FROM workflows WHERE id = ? AND active = 1').get(row.id);
          if (!fresh) return;
          startExecution(
            { ...fresh, nodes: JSON.parse(fresh.nodes), edges: JSON.parse(fresh.edges) },
            { trigger: 'schedule', startNodeId: node.id, triggerData: { triggeredAt: new Date().toISOString(), trigger: 'schedule' } }
          );
        })
      );
      console.log(`[scheduler] workflow ${row.id} scheduled: ${expr}`);
    }
  }
}

module.exports = { reschedule, cronExpression };
