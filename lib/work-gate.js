// A small counting semaphore with a bounded wait queue, for work whose cost is CPU or memory
// rather than a client's request rate (PDF parsing, image decoding). Per-client rate limits
// cannot bound what many clients ask at once; this does, process-wide.
class GateFullError extends Error {
  constructor(retryAfterSeconds) {
    super('The server is busy processing other uploads. Please try again shortly.');
    this.name = 'GateFullError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function createWorkGate({ concurrency, queue, retryAfterSeconds = 5 }) {
  let active = 0;
  const waiting = [];

  function release() {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next waiter; `active` is unchanged
    else active -= 1;
  }

  // Runs `task` once a slot is free. Rejects with GateFullError, without running it, when
  // `concurrency` tasks are running and `queue` more are already waiting.
  async function run(task) {
    if (active < concurrency) {
      active += 1;
    } else if (waiting.length < queue) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      throw new GateFullError(retryAfterSeconds);
    }
    try {
      return await task();
    } finally {
      release();
    }
  }

  return { run, stats: () => ({ active, waiting: waiting.length }) };
}

module.exports = { createWorkGate, GateFullError };
