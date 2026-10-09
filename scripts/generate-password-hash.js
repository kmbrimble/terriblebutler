#!/usr/bin/env node
// Recovery tool for a forgotten household login password. Run this, then set the
// printed hash as AUTH_PASSWORD_HASH on the terrible-butler container and restart it.
// See CLAUDE.md, "Recovery: forgotten household login password".
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/generate-password-hash.js <new-password>');
  process.exit(1);
}
// bcrypt reads only the first 72 bytes of a password. Hashing a longer one would quietly accept any
// text that shares those 72 bytes, so refuse it rather than print a hash for a password that is
// not what it looks like. (Counted in UTF-8 bytes, so multi-byte characters use it up faster.)
const BCRYPT_MAX_BYTES = 72;
const bytes = Buffer.byteLength(password, 'utf8');
if (bytes > BCRYPT_MAX_BYTES) {
  console.error(`Password is ${bytes} bytes; bcrypt only uses the first ${BCRYPT_MAX_BYTES}, so anything longer is not checked. Use a password of at most ${BCRYPT_MAX_BYTES} bytes.`);
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 10));
