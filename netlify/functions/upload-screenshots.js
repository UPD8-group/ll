/**
 * LISTING LENS — Upload Screenshots (Netlify Blobs version)
 *
 * Stores screenshots in Netlify Blobs instead of Upstash Redis.
 * Blobs handle large files natively — no 431 header size issues.
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
const { getStore } = require('@netlify/blobs');

const MAX_FILES      = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const VALID_MIME     = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VALID_CATS     = ['vehicle','property','electronics','other'];
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes in ms

function parseMultipart(event) {
    return new Promise((resolve, reject) => {
        const fields = {};
        const files  = [];
        const bb     = Busboy({ headers: { 'content-type': event.headers['content-type'] } });

        bb.on('field', (name, val) => { fields[name] = val; });

        bb.on('file', (name, stream, info) => {
            if (!VALID_MIME.includes(info.mimeType)) {
                stream.resume();
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
                        buffer: Buffer.concat(chunks)
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
        const { fields, files } = await parseMultipart(event);
        const category = fields.category;

        if (!category || !VALID_CATS.includes(category)) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid category' }) };
        }
        if (files.length === 0) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'No valid images uploaded' }) };
        }

        // Generate session ID
        const sessionId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
        const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

        // Store in Netlify Blobs
        const store = getStore({
            name: 'listing-lens-sessions',
            siteID: '723a91f3-c306-48fd-b0d7-382ba89fb9a0',
            token: process.env.NETLIFY_TOKEN
        });

        // Store each screenshot as a blob
        await Promise.all(
            files.map((f, i) =>
                store.set(
                    `${sessionId}/screenshot-${i}`,
                    f.buffer,
                    {
                        metadata: {
                            mimeType: f.mimeType,
                            expiresAt
                        }
                    }
                )
            )
        );

        // Store session metadata
        await store.setJSON(`${sessionId}/meta`, {
            category,
            screenshotCount: files.length,
            expiresAt,
            createdAt: new Date().toISOString()
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                sessionId,
                screenshotCount: files.length,
                category,
                expiresInSeconds: 900,
                message: `Screenshots stored securely. Session expires in 15 minutes.`
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
