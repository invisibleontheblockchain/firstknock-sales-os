import { randomUUID } from 'node:crypto';

function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export class WorkerRunner {
  constructor({ service, concurrency = 2, pollMs = 1_000, leaseMs = 120_000, logger = console }) {
    this.service = service;
    this.concurrency = concurrency;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.logger = logger;
    this.controller = null;
    this.loops = [];
  }

  start() {
    if (this.controller) return;
    this.controller = new AbortController();
    this.loops = Array.from({ length: this.concurrency }, (_, index) => this.runLoop(index, this.controller.signal));
  }

  async runLoop(index, signal) {
    const workerId = `canvas-worker:${process.pid}:${index}:${randomUUID()}`;
    while (!signal.aborted) {
      try {
        const result = await this.service.processNextJob(workerId, this.leaseMs);
        if (!result) await delay(this.pollMs, signal);
        else if (result.error) this.logger.error('[canvas-analysis-worker]', result.error.code);
      } catch (error) {
        this.logger.error('[canvas-analysis-worker]', error?.name || 'unexpected_error');
        await delay(this.pollMs, signal);
      }
    }
  }

  async stop() {
    if (!this.controller) return;
    this.controller.abort();
    await Promise.allSettled(this.loops);
    this.controller = null;
    this.loops = [];
  }
}
