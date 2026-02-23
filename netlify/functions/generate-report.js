/**
 * LISTING LENS — Generate Report (Trigger)
 * 
 * Creates a jobId, then calls generate-report-background directly.
 * The background function URL accepts POST and Netlify keeps it alive.
 * Returns jobId immediately for frontend polling.
 */

const crypto       = require('crypto');
const { getStore } = require('@netlify/blobs');

const SITE_ID = '723a91f3-c306-48fd-b0d7-382ba89fb9a0';

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
        const body      = JSON.parse(event.body || '{}');
        const sessionId = body.sessionId;
        const paymentId = body.paymentIntentId;

        if (!sessionId)
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'sessionId required' }) };

        // Check session exists
        const store = getStore({ name: 'listing-lens-sessions', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });
        let meta;
        try { meta = await store.get(sessionId + '/meta', { type: 'json' }); } catch (_) { meta = null; }

        if (!meta)
            return { statusCode: 410, headers, body: JSON.stringify({ error: 'Session expired', message: 'Please re-upload your screenshots.' }) };

        const jobId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);

        // Call background function directly — Netlify keeps it alive after 202
        const proto = event.headers['x-forwarded-proto'] || 'https';
        const host  = event.headers['host'];
        const bgUrl = proto + '://' + host + '/.netlify/functions/generate-report-background';

        console.log('Triggering background function:', bgUrl, 'jobId:', jobId);

        const bgRes = await fetch(bgUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ jobId, sessionId, paymentIntentId: paymentId })
        });

        console.log('Background function response status:', bgRes.status);

        return { statusCode: 202, headers, body: JSON.stringify({ jobId, status: 'processing' }) };

    } catch (err) {
        console.error('Trigger error:', err.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
