// The parts of rate limiting that need no configuration: how a client address becomes a key,
// and the bounded fixed-window counter. Shared by the Express limiters (lib/middleware.js) and
// the Socket.IO handshake limiter (lib/realtime.js); kept free of lib/config.js so the latter
// can be loaded on its own.
const net = require('net');

// Expands an IPv6 literal (compressed, zone id, embedded dotted IPv4) to eight 16-bit
// groups, or null if it is not IPv6.
function ipv6Groups(address) {
  const bare = address.split('%')[0];
  if (!net.isIPv6(bare)) return null;
  const expand = (part) => (part === '' ? [] : part.split(':').flatMap((piece) => {
    if (!piece.includes('.')) return [parseInt(piece, 16)];
    const [a, b, c, d] = piece.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
  }));
  const [head, tail] = bare.split('::');
  const headGroups = expand(head);
  if (tail === undefined) return headGroups;
  const tailGroups = expand(tail);
  return [...headGroups, ...new Array(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
}

// The identity rate limits are keyed on. An IPv6 client is normally handed a whole /64 (or
// larger), so keying on the full address would let it rotate addresses for fresh buckets;
// IPv6 is keyed on its /64 prefix. IPv4, and IPv4-mapped IPv6 in either notation, stay a
// plain IPv4 address. Logs keep the full address (clientAddress in lib/middleware.js).
function keyForAddress(address) {
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}
// One bucket map per limiter, so flooding one (say the general API limiter) can never evict
// another's entries (the login limiter's attempt counts).
const allBucketMaps = [];
// Upper bound on tracked clients per limiter, so a flood of distinct source addresses cannot
// grow a map without limit between cleanup sweeps.
const MAX_RATE_LIMIT_BUCKETS = 50000;

// Makes room for one new bucket. A bucket that is currently over its limit is an active
// lockout, so the oldest bucket that is NOT locked is dropped instead: flooding with distinct
// clients can never release a locked-out one. Only if every bucket is locked (the attacker
// has paid more than maxRequests requests from each of 50,000 distinct clients) is the
// lockout expiring soonest dropped, which keeps the map bounded.
// ponytail: O(n) scan, only when the map is full; an index of unlocked keys if that ever shows up in profiles.
function evictOne(buckets, maxRequests, now) {
  let soonest;
  for (const [key, bucket] of buckets) {
    if (bucket.count <= maxRequests || bucket.resetAt <= now) return buckets.delete(key);
    if (!soonest || bucket.resetAt < buckets.get(soonest).resetAt) soonest = key;
  }
  buckets.delete(soonest);
}

// The counting core, shared by the Express limiters and the Socket.IO handshake limiter
// (lib/realtime.js): fixed windows per key, a bounded bucket map. hit(key) records one request
// and says whether it is over the limit and when the window resets.
function createHitCounter({ windowMs, maxRequests, bucketName }) {
  const rateLimitBuckets = new Map();
  allBucketMaps.push(rateLimitBuckets);
  function hit(clientId) {
    const now = Date.now();
    const key = `${bucketName}:${clientId}`;

    let bucket = rateLimitBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 0,
        resetAt: now + windowMs
      };
    }

    bucket.count += 1;
    if (!rateLimitBuckets.has(key) && rateLimitBuckets.size >= MAX_RATE_LIMIT_BUCKETS) {
      evictOne(rateLimitBuckets, maxRequests, now);
    }
    rateLimitBuckets.set(key, bucket);

    // Seconds until the window resets (RateLimit-Reset and Retry-After agree).
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { limited: bucket.count > maxRequests, remaining: Math.max(0, maxRequests - bucket.count), resetSeconds };
  }
  return { hit, buckets: rateLimitBuckets };
}

const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const buckets of allBucketMaps) {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
}, 5 * 60 * 1000);

rateLimitCleanupTimer.unref();

module.exports = { keyForAddress, createHitCounter, MAX_RATE_LIMIT_BUCKETS };
