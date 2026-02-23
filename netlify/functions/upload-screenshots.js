/**
 * LISTING LENS — Upload Screenshots
 *
 * Called when the user selects files and hits the payment step.
 * Stores screenshots in Upstash Redis with 15-minute TTL.
 * Returns a sessionId the frontend holds onto through payment.
 *
 * This means if Stripe's embedded element causes any page state issue,
 * the screenshots are safe in Redis and can be retrieved for report generation.
 *
 * Route: POST /api/upload-screenshots
 * Body: multipart/form-data
 *   - category: string
 *   - screenshot_0, screenshot_1, ... screenshot_N: image files
 *
 * Returns: { sessionId, screenshotCount, expiresInSeconds }
 */

const Busboy = require('busboy');
const crypto = require('crypto');
const store  = require('./lib/store');

const MAX_FILES      = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const VALID_MIME     = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VALID_CATS     = ['vehicle','property','electronics','other'];

function parseMultipart(event) {
    return new Promise((resolve, reject) => {
        const fields = {};
        const files  = [];
        const bb     = Busboy({ headers: { 'content-type': event.headers['content-type'] } });

        bb.on('field', (name, val) => { fields[name] = val; });

        bb.on('file', (name, stream, info) => {
            if (!VALID_MIME.includes(info.mimeType)) {
                stream.resume(); // discard
                return;
            }
            const chunks = [];
            let size = 0;
            stream.on('data', chunk => {
                size += chunk.length;
                if (size <= MAX_FILE_BYTES) chunks.push(chunk);
                else stream.destroy();
            });
            stream.on('end', () => {
                if (chunks.length > 0 && files.length < MAX_FILES) {
                    files.push({
                        mimeType: info.mimeType,
                        base64: Buffer.concat(chunks).toString('base64')
                    });
                }
            });
        });

        bb.on('finish', () => resolve({ fields, files }));
        bb.on('error', reject);

        const body = event.isBase64Encoded
            ? Buffer.from(event.body, 'base64')
            : Buffer.from(event.body || '');
        bb.end(body);
    });
}

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST')
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        // Rate limiting
        const ip = (event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
        const rate = await store.checkRateLimit(ip);
        if (!rate.allowed) {
            return {
                statusCode: 429, headers,
                body: JSON.stringify({
                    error: 'Too many requests. Please wait an hour before trying again.',
                    remaining: 0
                })
            };
        }

        const { fields, files } = await parseMultipart(event);
        const category = fields.category;

        if (!category || !VALID_CATS.includes(category)) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid category' }) };
        }
        if (files.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid images uploaded' }) };
        }

        // Generate a session ID — this is the user's handle through payment
        const sessionId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);

        // Store each screenshot in Redis with 15-min TTL
        await Promise.all(
            files.map((f, i) => store.storeScreenshot(sessionId, i, f.mimeType, f.base64))
        );

        // Store session metadata
        await store.storeSession(sessionId, {
            category,
            screenshotCount: files.length
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                sessionId,
                screenshotCount: files.length,
                category,
                expiresInSeconds: store.SCREENSHOT_TTL_SECONDS,
                message: `Screenshots stored securely. Session expires in ${store.SCREENSHOT_TTL_SECONDS / 60} minutes.`
            })
        };

    } catch (err) {
        console.error('Upload error:', err);
        return {
            statusCode: 500, headers,
            body: JSON.stringify({ error: 'Upload failed', message: err.message })
        };
    }
};
