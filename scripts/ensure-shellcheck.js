// Provides a pinned, checksum-verified ShellCheck binary for the shellcheck test
// (test/shellcheck.test.js), without adding an npm dependency tree for a linter: the release
// tarball is fetched once from the official GitHub release into node_modules/.cache, its SHA-256
// is checked against the value pinned below (these match the digests GitHub publishes for the
// v0.11.0 release assets), and only then is it unpacked. Nothing here is part of the container image.
//
//   node scripts/ensure-shellcheck.js      prints the path of the binary, fetching it if needed
//   SHELLCHECK_BIN=/path/to/shellcheck     use that binary instead (it must report version 0.11.0)
// Unpacking needs `tar` with xz support, or python3 as a fallback (the release is .tar.xz only).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '0.11.0';
const PINNED = {
  'linux-x64': ['linux.x86_64', '8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198'],
  'linux-arm64': ['linux.aarch64', '12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588'],
  'darwin-x64': ['darwin.x86_64', '3c89db4edcab7cf1c27bff178882e0f6f27f7afdf54e859fa041fca10febe4c6'],
  'darwin-arm64': ['darwin.aarch64', '56affdd8de5527894dca6dc3d7e0a99a873b0f004d7aabc30ae407d3f48b0a79'],
};
const CACHE_DIR = path.join(__dirname, '..', 'node_modules', '.cache', `shellcheck-${VERSION}`);

function reportedVersion(bin) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- bin is our own cached download or the developer's SHELLCHECK_BIN, run with fixed arguments and no shell
  const run = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return run.status === 0 ? (/^version: (\S+)/m.exec(run.stdout) || [])[1] : null;
}

async function ensureShellcheck() {
  if (process.env.SHELLCHECK_BIN) {
    if (reportedVersion(process.env.SHELLCHECK_BIN) !== VERSION) throw new Error(`SHELLCHECK_BIN must be ShellCheck ${VERSION}.`);
    return process.env.SHELLCHECK_BIN;
  }
  const bin = path.join(CACHE_DIR, `shellcheck-v${VERSION}`, 'shellcheck');
  if (fs.existsSync(bin) && reportedVersion(bin) === VERSION) return bin;

  const pinned = PINNED[`${process.platform}-${process.arch}`];
  if (!pinned) throw new Error(`No pinned ShellCheck ${VERSION} for ${process.platform}-${process.arch}; set SHELLCHECK_BIN.`);
  const [asset, expected] = pinned;
  const url = `https://github.com/koalaman/shellcheck/releases/download/v${VERSION}/shellcheck-v${VERSION}.${asset}.tar.xz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Downloading ShellCheck failed: HTTP ${response.status} for ${url}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(tarball).digest('hex');
  if (actual !== expected) throw new Error(`ShellCheck ${VERSION} download failed its checksum (expected ${expected}, got ${actual}); refusing to use it.`);

  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const archive = path.join(CACHE_DIR, 'shellcheck.tar.xz');
  fs.writeFileSync(archive, tarball);
  // The release is .tar.xz only: GNU tar needs the xz tool, Python's tarfile does not.
  let untar = spawnSync('tar', ['-xJf', archive, '-C', CACHE_DIR], { encoding: 'utf8' });
  if (untar.status !== 0) untar = spawnSync('python3', ['-I', '-m', 'tarfile', '-e', archive, CACHE_DIR], { encoding: 'utf8' });
  if (untar.status !== 0) throw new Error(`Unpacking ShellCheck failed (needs tar with xz, or python3): ${untar.stderr}`);
  if (reportedVersion(bin) !== VERSION) throw new Error('The unpacked ShellCheck did not run.');
  return bin;
}

module.exports = { ensureShellcheck, VERSION };

if (require.main === module) {
  ensureShellcheck().then((bin) => console.log(bin), (err) => { console.error(err.message); process.exit(1); });
}
