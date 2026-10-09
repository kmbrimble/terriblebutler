import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const { createWorkGate, GateFullError } = createRequire(import.meta.url)('../lib/work-gate.js');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('work gate', () => {
  it('runs up to `concurrency` tasks at once, queues up to `queue` more, and refuses the rest', async () => {
    const gate = createWorkGate({ concurrency: 2, queue: 1, retryAfterSeconds: 7 });
    const a = deferred(); const b = deferred(); const c = deferred();
    const ran = [];
    const pa = gate.run(async () => { ran.push('a'); await a.promise; return 'A'; });
    const pb = gate.run(async () => { ran.push('b'); await b.promise; return 'B'; });
    const pc = gate.run(async () => { ran.push('c'); await c.promise; return 'C'; });
    expect(gate.stats()).toEqual({ active: 2, waiting: 1 });
    await expect(gate.run(async () => ran.push('d'))).rejects.toMatchObject({ name: 'GateFullError', retryAfterSeconds: 7 });
    await expect(gate.run(async () => {})).rejects.toBeInstanceOf(GateFullError);
    expect(ran).toEqual(['a', 'b']);

    a.resolve(); // frees a slot: the queued task starts
    await pa;
    await Promise.resolve();
    expect(ran).toEqual(['a', 'b', 'c']);
    b.resolve(); c.resolve();
    expect(await Promise.all([pb, pc])).toEqual(['B', 'C']);
    expect(gate.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it('frees the slot when a task throws', async () => {
    const gate = createWorkGate({ concurrency: 1, queue: 0 });
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.stats().active).toBe(0);
    expect(await gate.run(async () => 'ok')).toBe('ok');
  });
});
