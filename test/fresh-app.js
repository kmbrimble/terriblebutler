import path from 'path';
import { createRequire } from 'module';

// Loads a brand-new copy of the app with the given environment overrides. The server and lib/*
// are CommonJS pulled in by native require, which vi.resetModules() does not reset, so the
// project's entries are cleared from the require cache directly. Config such as TRUST_PROXY
// and the rate-limit maxima is read once at load, and limiter buckets live in module state,
// so a fresh copy is the only way to vary either per test.
const nodeRequire = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..') + path.sep;

export function loadFreshApp(env = {}, { beforeLoad } = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const file of Object.keys(nodeRequire.cache)) {
    if (file.startsWith(projectRoot) && !file.includes(`${path.sep}node_modules${path.sep}`)) delete nodeRequire.cache[file];
  }
  // Lets a test replace an export of a project module before server.js destructures it.
  if (beforeLoad) beforeLoad(nodeRequire);
  return nodeRequire('../server.js');
}
