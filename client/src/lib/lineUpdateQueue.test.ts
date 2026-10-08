import { describe, expect, it } from 'vitest';
import { createLineUpdateQueue } from './lineUpdateQueue';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  const sent: Array<{ lineId: number; fields: string; d: ReturnType<typeof deferred<string>> }> = [];
  const log: string[] = [];
  const queue = createLineUpdateQueue<string, string>({
    send: (lineId, fields) => {
      const d = deferred<string>();
      sent.push({ lineId, fields, d });
      return d.promise;
    },
    onOptimistic: (id, f) => log.push(`opt:${id}:${f}`),
    onSettled: (id, row) => log.push(`set:${id}:${row}`),
    onError: (id, err, latest) => log.push(`err:${id}:${(err as Error).message}:${latest}`),
  });
  return { queue, sent, log };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createLineUpdateQueue', () => {
  it('sends edits to one line strictly in order, never concurrently', async () => {
    const { queue, sent } = setup();
    queue.enqueue(1, 'a');
    queue.enqueue(1, 'b');
    await tick();
    expect(sent.map((s) => s.fields)).toEqual(['a']);
    sent[0].d.resolve('row-a');
    await tick();
    expect(sent.map((s) => s.fields)).toEqual(['a', 'b']);
  });

  it('applies only the newest response, so a stale one cannot overwrite it', async () => {
    const { queue, sent, log } = setup();
    queue.enqueue(1, 'a');
    queue.enqueue(1, 'b');
    await tick();
    sent[0].d.resolve('row-a');
    await tick();
    sent[1].d.resolve('row-b');
    await tick();
    expect(log).toEqual(['opt:1:a', 'opt:1:b', 'set:1:row-b']);
  });

  it('lets different lines proceed independently', async () => {
    const { queue, sent } = setup();
    queue.enqueue(1, 'a');
    queue.enqueue(2, 'b');
    await tick();
    expect(sent.map((s) => s.lineId)).toEqual([1, 2]);
  });

  it('reports a failure, flags whether it was the latest, and keeps processing later edits', async () => {
    const { queue, sent, log } = setup();
    queue.enqueue(1, 'a');
    queue.enqueue(1, 'b');
    await tick();
    sent[0].d.reject(new Error('boom'));
    await tick();
    sent[1].d.resolve('row-b');
    await tick();
    expect(log).toEqual(['opt:1:a', 'opt:1:b', 'err:1:boom:false', 'set:1:row-b']);
  });

  it('flags a failure of the only outstanding edit as latest', async () => {
    const { queue, sent, log } = setup();
    queue.enqueue(1, 'a');
    await tick();
    sent[0].d.reject(new Error('nope'));
    await tick();
    expect(log).toEqual(['opt:1:a', 'err:1:nope:true']);
  });
});

describe('drain', () => {
  it('waits for queued edits to settle', async () => {
    const { queue, sent } = setup();
    queue.enqueue(1, 'a');
    let drained = false;
    const p = queue.drain().then(() => { drained = true; });
    await tick();
    expect(drained).toBe(false);
    sent[0].d.resolve('row');
    await p;
    expect(drained).toBe(true);
  });
});

describe('drain after a failed edit', () => {
  it('rejects while the latest edit of a line has failed, and recovers after a later success', async () => {
    const { queue, sent } = setup();
    queue.enqueue(1, 'a');
    await tick();
    sent[0].d.reject(new Error('nope'));
    await expect(queue.drain()).rejects.toThrow(/could not be saved/);
    queue.enqueue(1, 'b');
    await tick();
    sent[1].d.resolve('row-b');
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
