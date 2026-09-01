const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AccountMaintenanceScheduler,
  DEFAULT_RETRY_DELAY_MS,
  initialDelay,
  jitter
} = require('../src/account-maintenance.cjs');

test('maintenance delay is jittered and overdue work starts shortly after activation', () => {
  assert.equal(jitter(1000, 0), 900);
  assert.equal(jitter(1000, 0.5), 1000);
  assert.equal(jitter(1000, 1), 1100);
  assert.equal(initialDelay({ intervalMs: 5000, lastRunAt: 0, now: 10_000, random: 0.5 }), 75_000);
  assert.equal(initialDelay({ intervalMs: 5000, lastRunAt: 8000, now: 10_000, random: 0.5 }), 3000);
});

test('scheduler stays idle until enabled and records completed maintenance', async () => {
  let enabled = false;
  let lastRun;
  let completed = 0;
  const timers = [];
  const scheduler = new AccountMaintenanceScheduler({
    readConfig: () => ({ enabled, intervalMs: 5 * 60 * 60 * 1000 }),
    readLastRun: () => lastRun,
    writeLastRun: async (value) => { lastRun = value; },
    run: async () => ({ locked: false, completedAt: new Date(20_000).toISOString(), results: [] }),
    onComplete: async () => { completed++; },
    now: () => 10_000,
    random: () => 0.5,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; }
  });

  scheduler.start();
  assert.equal(timers.length, 0);
  enabled = true;
  scheduler.reschedule();
  assert.equal(timers[0].delay, 75_000);
  await scheduler.runNow();
  assert.equal(lastRun, 20_000);
  assert.equal(completed, 1);
  assert.equal(timers.at(-1).delay, 5 * 60 * 60 * 1000);
  scheduler.dispose();
  assert.equal(timers.at(-1).cleared, true);
});

test('a contended maintenance lock retries without advancing last-run state', async () => {
  let writes = 0;
  let scheduled;
  const scheduler = new AccountMaintenanceScheduler({
    readConfig: () => ({ enabled: true, intervalMs: 5 * 60 * 60 * 1000 }),
    readLastRun: () => 0,
    writeLastRun: async () => { writes++; },
    run: async () => ({ locked: true, results: [] }),
    random: () => 0.5,
    setTimer: (callback, delay) => {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimer: () => {}
  });

  await scheduler.runNow();
  assert.equal(writes, 0);
  assert.equal(scheduled.delay, DEFAULT_RETRY_DELAY_MS);
});
