/**
 * LISTING LENS — Upstash Redis Store
 *
 * Thin wrapper around the Upstash REST API.
 * No npm package required — just fetch().
 *
 * Used for:
 *   - Temporary screenshot storage (15-min TTL, auto-purged)
 *   - Rate limiting by IP
 *   - Payment → session linking
 *
 * Setup:
 *   1. Create a free Redis database at https://upstash.com
 *   2. Add to Netlify env vars:
 *        UPSTASH_REDIS_REST_URL   (e.g. https://xxx.upstash.io)
 *        UPSTASH_REDIS_REST_TOKEN (the REST token from Upstash dashboard)
 */

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// How long screenshots are kept, in seconds.
// 15 minutes is the stated policy in Terms and Privacy.
// Enough to survive slow connections, payment friction, and retries.
const SCREENSHOT_TTL_SECONDS = 15 * 60; // 900

// Rate limit window and ceiling
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60; // 1 hour
const RATE_LIMIT_MAX_REQUESTS   = 100;     // per IP per hour (raised for testing)

/**
 * Raw Upstash REST call.
 * Commands are passed as path segments: /SET/key/value, /GET/key, etc.
 */
async function upstash(...args) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        throw new Error('Upstash env vars not set (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
    }
    const url = `${UPSTASH_URL}/${args.map(a => encodeURIComponent(a)).join('/')}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upstash error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.result;
}

/**
 * Store screenshot data temporarily.
 * Key: screenshot:{sessionId}:{index}
 * Value: JSON string { mimeType, base64 }
 * TTL: SCREENSHOT_TTL_SECONDS (auto-purged by Redis)
 *
 * Returns the key, so you can retrieve it in generate-report.
 */
async function storeScreenshot(sessionId, index, mimeType, base64) {
    const key   = `screenshot:${sessionId}:${index}`;
    const value = JSON.stringify({ mimeType, base64 });
    // SET key value EX seconds
    await upstash('SET', key, value, 'EX', SCREENSHOT_TTL_SECONDS);
    return key;
}

/**
 * Retrieve a screenshot.
 * Returns { mimeType, base64 } or null if expired/not found.
 */
async function getScreenshot(sessionId, index) {
    const key  = `screenshot:${sessionId}:${index}`;
    const data = await upstash('GET', key);
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
}

/**
 * Delete all screenshots for a session immediately.
 * Called after report generation — don't wait for TTL.
 */
async function deleteScreenshots(sessionId, count) {
    const keys = [];
    for (let i = 0; i < count; i++) {
        keys.push(`screenshot:${sessionId}:${i}`);
    }
    if (keys.length > 0) {
        await upstash('DEL', ...keys);
    }
}

/**
 * Store session metadata (category, screenshotCount, paymentIntentId).
 * TTL matches screenshots — if the session expires, the screenshots do too.
 */
async function storeSession(sessionId, data) {
    const key   = `session:${sessionId}`;
    const value = JSON.stringify({ ...data, createdAt: new Date().toISOString() });
    await upstash('SET', key, value, 'EX', SCREENSHOT_TTL_SECONDS);
}

/**
 * Retrieve session metadata.
 * Returns parsed object or null.
 */
async function getSession(sessionId) {
    const key  = `session:${sessionId}`;
    const data = await upstash('GET', key);
    if (!data) return null;
    try { return JSON.parse(data); } catch { return null; }
}

/**
 * Delete session metadata.
 * Called after report generation.
 */
async function deleteSession(sessionId) {
    await upstash('DEL', `session:${sessionId}`);
}

/**
 * Rate limit by IP address.
 * Returns { allowed: bool, count: number, remaining: number }
 *
 * Uses INCR + EXPIRE — safe for concurrent requests.
 * First request in window sets the expiry; subsequent ones just increment.
 */
async function checkRateLimit(ip) {
    const key   = `ratelimit:${ip}`;
    const count = await upstash('INCR', key);

    // Set expiry only on first request (count === 1)
    if (count === 1) {
        await upstash('EXPIRE', key, RATE_LIMIT_WINDOW_SECONDS);
    }

    const allowed   = count <= RATE_LIMIT_MAX_REQUESTS;
    const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - count);

    return { allowed, count, remaining };
}

/**
 * Get remaining TTL for a screenshot session (seconds).
 * Returns -2 if key doesn't exist, -1 if no expiry, otherwise seconds remaining.
 */
async function getSessionTTL(sessionId) {
    return await upstash('TTL', `session:${sessionId}`);
}

module.exports = {
    storeScreenshot,
    getScreenshot,
    deleteScreenshots,
    storeSession,
    getSession,
    deleteSession,
    checkRateLimit,
    getSessionTTL,
    SCREENSHOT_TTL_SECONDS
};
