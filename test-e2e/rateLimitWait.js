// Shared by any spec file whose real mutations (POST/PUT/PATCH/DELETE) risk exceeding the
// server's mutationRateLimiter (90 per 60s per IP) — a budget shared across the WHOLE e2e run,
// not just one file. See v2-item-detail.spec.js's header comment for the original diagnosis (a
// silently-swallowed 429 on GET /api/locations).

// For a mutation fired directly through Playwright's `request` fixture: retry against the
// server's own Reset header after an ACTUAL 429, rather than guessing a safety margin in
// advance. A pre-emptive probe-then-proceed check was tried first but wasn't reliable — with
// several spec files making mutations close together in wall-clock time, even a
// generous-looking remaining count (5 of 90) still 429'd on the very next request a few
// milliseconds later. Retrying on the real response beats predicting one.
export async function requestWithRateLimitRetry(makeRequest, maxAttempts = 3) {
  let lastResponse;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await makeRequest();
    if (response.status() !== 429) return response;
    lastResponse = response;
    const resetAtSeconds = Number(response.headers()['ratelimit-reset']);
    const waitMs = Number.isFinite(resetAtSeconds) ? Math.max(0, resetAtSeconds * 1000 - Date.now()) + 500 : 2000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return lastResponse;
}

// For a mutation fired from browser-side UI code (a file upload, a button click) that can't be
// individually retried after the fact: wait out the window pre-emptively whenever the budget
// looks tight. Deliberately generous — the same stale-margin problem above means a merely
// "some room left" reading isn't trustworthy, so this only skips waiting when there's a lot of
// headroom, and otherwise waits out the whole window rather than trying to fine-tune a margin.
export async function waitForMutationBudget(probeResponse, neededHeadroom = 25) {
  const remaining = Number(probeResponse.headers()['ratelimit-remaining']);
  const resetAtSeconds = Number(probeResponse.headers()['ratelimit-reset']);
  if (!Number.isFinite(remaining) || !Number.isFinite(resetAtSeconds) || remaining < neededHeadroom) {
    const waitMs = Number.isFinite(resetAtSeconds) ? Math.max(0, resetAtSeconds * 1000 - Date.now()) + 500 : 2000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
