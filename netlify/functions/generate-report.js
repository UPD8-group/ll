/**
 * LISTING LENS — Generate Report (Trigger Only)
 *
 * Validates the request, fires the background function,
 * and immediately returns a jobId for the frontend to poll.
 *
 * Route: POST /api/generate-report
 * Body:  { sessionId, paymentIntentId }
 * Returns: { jobId, status: 'processing' }
 */

const crypto       = require('crypto');
const { getStore } = require('@netlify/blobs');

const SITE_ID = '723a91f3-c306-48fd-b0d7-382ba89fb9a0';

function blobStore() {
    return getStore({ name: 'listing-lens-sessions', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });
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
        const body            = JSON.parse(event.body || '{}');
        const sessionId       = body.sessionId;
        const paymentIntentId = body.paymentIntentId;

        if (!sessionId)
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'sessionId required' }) };

        // Quick session check before firing background job
        const store = blobStore();
        let meta;
        try {
            meta = await store.get(`${sessionId}/meta`, { type: 'json' });
        } catch (e) {
            meta = null;
        }

        if (!meta) {
            return {
                statusCode: 410, headers,
                body: JSON.stringify({
                    error: 'Session expired',
                    message: 'Your screenshots have been automatically deleted (15-minute limit). Please upload again.'
                })
            };
        }

        if (new Date(meta.expiresAt) < new Date()) {
            try { await store.delete(`${sessionId}/meta`); } catch (_) {}
            return {
                statusCode: 410, headers,
                body: JSON.stringify({
                    error: 'Session expired',
                    message: 'Your session has expired. Please upload again.'
                })
            };
        }

        // Generate job ID and store initial status
        const jobId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);
        await store.setJSON(`job/${jobId}`, { status: 'queued', queuedAt: new Date().toISOString() });

        // Fire background function — do NOT await, it runs independently
        const proto  = (event.headers['x-forwarded-proto'] || 'https');
        const host   = event.headers['host'];
        const bgUrl  = `${proto}://${host}/.netlify/functions/generate-report-background`;

        fetch(bgUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ jobId, sessionId, paymentIntentId })
        }).catch(err => console.error('Background trigger failed:', err.message));

        // Return immediately — frontend polls /api/report-status?jobId=xxx
        return {
            statusCode: 202, headers,
            body: JSON.stringify({ jobId, status: 'processing' })
        };

    } catch (error) {
        console.error('Trigger error:', error);
        return {
            statusCode: 500, headers,
            body: JSON.stringify({ error: 'Failed to start report generation', message: error.message })
        };
    }
};
