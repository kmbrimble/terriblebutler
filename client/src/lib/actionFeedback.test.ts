import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.fn();
vi.mock('./toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
let token: string | null = 'tok';
vi.mock('./api', () => ({ getToken: () => token }));

import { installRejectionToast, reportAction, runAction } from './actionFeedback';

beforeEach(() => {
  showToast.mockClear();
  token = 'tok';
});
afterEach(() => vi.restoreAllMocks());

describe('runAction', () => {
  it('returns the value and shows nothing on success', async () => {
    expect(await runAction(async () => 7, 'x')).toEqual({ ok: true, value: 7 });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("toasts the error's own message and reports failure", async () => {
    expect(await runAction(async () => { throw new Error('Insufficient quantity'); }, 'fallback')).toEqual({ ok: false });
    expect(showToast).toHaveBeenCalledWith('Insufficient quantity', 'error');
  });

  it('falls back to the supplied message for non-Error rejections', async () => {
    await runAction(() => Promise.reject('boom'), 'Could not save.');
    expect(showToast).toHaveBeenCalledWith('Could not save.', 'error');
  });

  it('stays quiet when the session just ended (token cleared by a 401)', async () => {
    token = null;
    await runAction(async () => { throw new Error('Unauthorized'); }, 'x');
    expect(showToast).not.toHaveBeenCalled();
  });

  it('catches a synchronous throw too', async () => {
    expect(await runAction(() => { throw new Error('sync'); }, 'x')).toEqual({ ok: false });
    expect(showToast).toHaveBeenCalledWith('sync', 'error');
  });
});

describe('reportAction', () => {
  it('never rejects and toasts a failure', async () => {
    reportAction(Promise.reject(new Error('nope')), 'x');
    await new Promise((r) => setTimeout(r, 0));
    expect(showToast).toHaveBeenCalledWith('nope', 'error');
  });
});

describe('installRejectionToast', () => {
  it('toasts a generic message for any unhandled rejection and can be removed', () => {
    const target = new EventTarget();
    const remove = installRejectionToast(target);
    const ev = Object.assign(new Event('unhandledrejection'), { reason: new Error('late') });
    target.dispatchEvent(ev);
    expect(showToast).toHaveBeenCalledWith('Something went wrong: late', 'error');
    remove();
    showToast.mockClear();
    target.dispatchEvent(ev);
    expect(showToast).not.toHaveBeenCalled();
  });
});
