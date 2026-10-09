// In production TRUST_PROXY must be an explicit decision: an address/CIDR/hop list, or the literal `none`.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import './setup.js';
import { loadFreshApp } from './fresh-app.js';

const nodeRequire = createRequire(import.meta.url);
const original = { NODE_ENV: process.env.NODE_ENV, TRUST_PROXY: process.env.TRUST_PROXY };
afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function loadConfig(env) {
  loadFreshApp(env);
  return nodeRequire('../lib/config');
}
const production = (TRUST_PROXY) => ({ NODE_ENV: 'production', TRUST_PROXY });

describe('NODE_ENV=production', () => {
  const expectRefusal = (fn) => {
    let error;
    try { fn(); } catch (err) { error = err; }
    expect(error).toBeTruthy();
    expect(error.message).toContain('TRUST_PROXY must be set when NODE_ENV=production');
    expect(error.message).toContain('"none"');
  };

  it('refuses to start with TRUST_PROXY unset, naming the variable and the options', () => {
    delete process.env.TRUST_PROXY;
    expectRefusal(() => loadConfig({ NODE_ENV: 'production' }));
  });

  it.each([[''], ['   ']])('and with it blank (%j)', (value) => {
    expectRefusal(() => loadConfig(production(value)));
  });

  it('`none` (any case) means trust nothing', () => {
    for (const value of ['none', 'NONE', ' None ']) expect(loadConfig(production(value)).TRUST_PROXY, value).toBe(false);
  });

  it('a proxy address, CIDR list or hop count is accepted and parsed as before', () => {
    expect(loadConfig(production('172.18.0.5')).TRUST_PROXY).toEqual(['172.18.0.5']);
    expect(loadConfig(production('172.18.0.5, 10.0.0.0/8')).TRUST_PROXY).toEqual(['172.18.0.5', '10.0.0.0/8']);
    expect(loadConfig(production('1')).TRUST_PROXY).toBe(1);
  });

  it('an invalid or trust-everything value is still refused', () => {
    for (const value of ['true', '*', '0.0.0.0/0', 'not-an-address', '99']) expect(() => loadConfig(production(value)), value).toThrow(/TRUST_PROXY/);
  });
});

describe('outside production the default is unchanged', () => {
  it.each(['test', 'development', undefined])('NODE_ENV=%s with TRUST_PROXY unset trusts nothing', (nodeEnv) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    delete process.env.TRUST_PROXY;
    const env = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
    expect(loadConfig(env).TRUST_PROXY).toBe(false);
  });

  it('`none` is accepted everywhere', () => {
    expect(loadConfig({ NODE_ENV: 'development', TRUST_PROXY: 'none' }).TRUST_PROXY).toBe(false);
  });
});

describe('trustProxyDecisionProblem', () => {
  const { trustProxyDecisionProblem } = nodeRequire('../lib/config');
  it('is a message only for production with a blank TRUST_PROXY', () => {
    expect(trustProxyDecisionProblem({ NODE_ENV: 'production' })).toMatch(/TRUST_PROXY/);
    expect(trustProxyDecisionProblem({ NODE_ENV: 'production', TRUST_PROXY: '' })).toMatch(/TRUST_PROXY/);
    expect(trustProxyDecisionProblem({ NODE_ENV: 'production', TRUST_PROXY: 'none' })).toBeNull();
    expect(trustProxyDecisionProblem({ NODE_ENV: 'test' })).toBeNull();
    expect(trustProxyDecisionProblem({})).toBeNull();
  });
});

describe('a real start-up', () => {
  it('exits non-zero with a message naming TRUST_PROXY when it is unset in production, and starts with `none`', () => {
    const env = { ...process.env, NODE_ENV: 'production', DB_PATH: path.join(os.tmpdir(), `butler-tp-${process.pid}.db`), PORT: '0' };
    delete env.TRUST_PROXY;
    const cwd = path.join(import.meta.dirname, '..');
    const refused = spawnSync('node', ['server.js'], { cwd, env, encoding: 'utf8', timeout: 20000 });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('TRUST_PROXY must be set when NODE_ENV=production');
    // `none`: the module graph loads and the process runs (server.js only listens when run directly, so ask config)
    const ok = spawnSync('node', ['-e', "console.log(JSON.stringify(require('./lib/config').TRUST_PROXY))"], { cwd, env: { ...env, TRUST_PROXY: 'none' }, encoding: 'utf8', timeout: 20000 });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim()).toBe('false');
  });
});
