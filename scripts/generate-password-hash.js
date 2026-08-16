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
console.log(bcrypt.hashSync(password, 10));
