const DEFAULT_INITIAL_DELAY_MIN_MS = 30 * 1000;
const DEFAULT_INITIAL_DELAY_MAX_MS = 2 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;
const DEFAULT_JITTER_RATIO = 0.1;

function shouldOfferClaudeMaintenance({ enabled, prompted, claudeAccounts }) {
  return !enabled && !prompted && Number(claudeAccounts) > 0;
}

class AccountMaintenanceScheduler {
  constructor(options) {
    this.options = options;
    this.timer = undefined;
    this.running = false;
    this.disposed = false;
    this.controller = undefined;
  }

  start() {
    this.reschedule();
  }

  reschedule() {
    this.clearTimer();
    if (this.disposed || !this.options.readConfig().enabled) return;
    const config = this.options.readConfig();
    const delay = initialDelay({
      intervalMs: config.intervalMs,
      lastRunAt: this.options.readLastRun(),
      now: this.now(),
      random: this.random()
    });
    this.schedule(delay);
  }

  async runNow() {
    if (this.disposed || this.running || !this.options.readConfig().enabled) return;
    this.clearTimer();
    this.running = true;
    this.controller = new AbortController();
    try {
      const maintenance = await this.options.run({ signal: this.controller.signal });
      const deferred = maintenance?.results?.some((item) => item.status === 'deferred');
      if (!maintenance?.locked) {
        if (!deferred) {
          const completedAt = Date.parse(maintenance?.completedAt || '') || this.now();
          await this.options.writeLastRun(completedAt);
        }
        await this.options.onComplete?.(maintenance);
      }
      this.scheduleNext(maintenance?.locked || deferred ? DEFAULT_RETRY_DELAY_MS : undefined);
      return maintenance;
    } catch (error) {
      if (!this.disposed && error?.name !== 'AbortError') this.options.onError?.(error);
      this.scheduleNext(DEFAULT_RETRY_DELAY_MS);
      return undefined;
    } finally {
      this.controller = undefined;
      this.running = false;
    }
  }

  scheduleNext(delay) {
    if (this.disposed || !this.options.readConfig().enabled) return;
    const interval = delay ?? this.options.readConfig().intervalMs;
    this.schedule(jitter(interval, this.random()));
  }

  schedule(delay) {
    this.clearTimer();
    this.timer = this.options.setTimer(() => {
      this.timer = undefined;
      void this.runNow();
    }, Math.max(1, Math.round(delay)));
  }

  clearTimer() {
    if (this.timer === undefined) return;
    this.options.clearTimer(this.timer);
    this.timer = undefined;
  }

  now() {
    return this.options.now?.() ?? Date.now();
  }

  random() {
    return this.options.random?.() ?? Math.random();
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
    this.controller?.abort();
  }
}

function initialDelay({ intervalMs, lastRunAt, now, random }) {
  const last = Number(lastRunAt);
  if (!Number.isFinite(last) || last <= 0 || now - last >= intervalMs) {
    return DEFAULT_INITIAL_DELAY_MIN_MS + random * (DEFAULT_INITIAL_DELAY_MAX_MS - DEFAULT_INITIAL_DELAY_MIN_MS);
  }
  return jitter(Math.max(1, intervalMs - (now - last)), random);
}

function jitter(value, random, ratio = DEFAULT_JITTER_RATIO) {
  const spread = value * ratio;
  return value - spread + 2 * spread * random;
}

module.exports = {
  AccountMaintenanceScheduler,
  initialDelay,
  jitter,
  DEFAULT_RETRY_DELAY_MS,
  shouldOfferClaudeMaintenance
};
