/**
 * LISTING LENS — Generate Report
 *
 * This IS the background function (renamed from generate-report-background).
 * Netlify background functions are triggered by POSTing to their URL.
 * The frontend calls this and immediately gets 202, then polls report-status.
 *
 * Because this file ends in nothing special but we configure it as background
 * in netlify.toml with a long timeout, we use a different approach:
 * We return 202 immediately AND continue processing via a detached promise.
 *
 * Route: POST /api/generate-report
 * Body:  { sessionId, paymentIntentId }
 * Returns: { jobId, status: 'processing' } immediately
 */

const Anthropic    = require('@anthropic-ai/sdk');
const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { getStore } = require('@netlify/blobs');

const VALID_CATEGORIES = ['vehicle', 'property', 'electronics', 'other'];
const SITE_ID          = '723a91f3-c306-48fd-b0d7-382ba89fb9a0';

function blobStore() {
    return getStore({ name: 'listing-lens-sessions', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });
}

function loadPrompt(filename) {
    const locations = [
        path.join(process.cwd(), 'prompts', filename),
        path.join(__dirname, '..', '..', 'prompts', filename),
        path.join(__dirname, 'prompts', filename)
    ];
    for (const p of locations) {
        try { return fs.readFileSync(p, 'utf-8'); } catch { /* try next */ }
    }
    return null;
}

async function verifyPayment(paymentIntentId) {
    if (process.env.BETA_MODE === 'true') return { valid: true };
    if (!paymentIntentId) return { valid: false, reason: 'No payment intent ID' };
    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (intent.status !== 'succeeded') return { valid: false, reason: 'Payment not succeeded' };
        if (![200, 500, 1000].includes(intent.amount)) return { valid: false, reason: 'Invalid amount' };
        if (intent.currency !== 'aud') return { valid: false, reason: 'Wrong currency' };
        if (intent.metadata && intent.metadata.report_generated === 'true') return { valid: false, reason: 'Already used' };
        await stripe.paymentIntents.update(paymentIntentId, {
            metadata: Object.assign({}, intent.metadata, { report_generated: 'true' })
        });
        return { valid: true };
    } catch (err) {
        return { valid: false, reason: err.message };
    }
}

async function runReportGeneration(jobId, sessionId, paymentIntentId) {
    const store = blobStore();

    try {
        await store.setJSON(`job/${jobId}`, { status: 'processing', startedAt: new Date().toISOString() });
        console.log(`Job ${jobId}: started`);

        const payment = await verifyPayment(paymentIntentId);
        if (!payment.valid) {
            await store.setJSON(`job/${jobId}`, { status: 'error', error: 'Payment failed: ' + payment.reason });
            return;
        }

        let meta;
        try { meta = await store.get(`${sessionId}/meta`, { type: 'json' }); } catch (_) { meta = null; }
        if (!meta) {
            await store.setJSON(`job/${jobId}`, { status: 'error', error: 'Session expired — please re-upload.' });
            return;
        }

        const { category, screenshotCount } = meta;
        if (!VALID_CATEGORIES.includes(category)) {
            await store.setJSON(`job/${jobId}`, { status: 'error', error: 'Invalid category' });
            return;
        }

        const screenshots = [];
        for (let i = 0; i < screenshotCount; i++) {
            try {
                const blob     = await store.get(`${sessionId}/screenshot-${i}`, { type: 'arrayBuffer' });
                const blobMeta = await store.getMetadata(`${sessionId}/screenshot-${i}`);
                if (blob) screenshots.push({
                    base64:   Buffer.from(blob).toString('base64'),
                    mimeType: (blobMeta?.metadata?.mimeType) || 'image/jpeg'
                });
            } catch (e) { console.warn(`Screenshot ${i} missing:`, e.message); }
        }

        if (screenshots.length === 0) {
            await store.setJSON(`job/${jobId}`, { status: 'error', error: 'Screenshots expired — please re-upload.' });
            return;
        }

        let systemPrompt = null;
        if (category === 'property')    systemPrompt = loadPrompt('combined-aus-property-v3.1.md');
        if (category === 'vehicle')     systemPrompt = loadPrompt('combined-aus-vehicle-v3.1.md');
        if (category === 'electronics') systemPrompt = loadPrompt('combined-aus-electronics-v3.1.md');
        if (category === 'other')       systemPrompt = loadPrompt('combined-aus-general-v3.1.md');
        if (!systemPrompt)              systemPrompt = loadPrompt('fast-universal-v1.md');

        if (!systemPrompt) {
            await store.setJSON(`job/${jobId}`, { status: 'error', error: 'Prompt file missing' });
            return;
        }

        const reportId = 'LL-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const today    = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
        systemPrompt  += `\n\n---\nReport ID: ${reportId}\nDate: ${today}\nCategory: ${category}\nScreenshots: ${screenshots.length}\n\nOutput ONLY valid HTML starting with <!DOCTYPE html>. No markdown, no code fences.`;

        console.log(`Job ${jobId}: calling Claude with ${screenshots.length} screenshots`);

        const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 8000,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: [
                ...screenshots.map(s => ({ type: 'image', source: { type: 'base64', media_type: s.mimeType, data: s.base64 } })),
                { type: 'text', text: `Analyse this ${category} listing and generate the complete Listing Lens buyer intelligence report as standalone HTML.` }
            ]}]
        });

        let html = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        html = html.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();
        const start = html.indexOf('<!DOCTYPE html>') !== -1 ? html.indexOf('<!DOCTYPE html>') : html.indexOf('<html');
        const end   = html.lastIndexOf('</html>');
        if (start !== -1 && end !== -1) html = html.substring(start, end + 7);

        console.log(`Job ${jobId}: Claude responded, storing report`);

        await store.setJSON(`job/${jobId}`, {
            status: 'complete', reportId, html, completedAt: new Date().toISOString()
        });

        // Cleanup screenshots
        try {
            await Promise.all([
                ...Array.from({ length: screenshotCount }, (_, i) => store.delete(`${sessionId}/screenshot-${i}`)),
                store.delete(`${sessionId}/meta`)
            ]);
        } catch (_) {}

        console.log(`Job ${jobId}: complete`);

    } catch (err) {
        console.error(`Job ${jobId} error:`, err);
        try { await store.setJSON(`job/${jobId}`, { status: 'error', error: err.message || 'Unknown error' }); } catch (_) {}
    }
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
        const body          = JSON.parse(event.body || '{}');
        const sessionId     = body.sessionId;
        const paymentId     = body.paymentIntentId;

        if (!sessionId)
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'sessionId required' }) };

        // Quick session check
        const store = blobStore();
        let meta;
        try { meta = await store.get(`${sessionId}/meta`, { type: 'json' }); } catch (_) { meta = null; }

        if (!meta)
            return { statusCode: 410, headers, body: JSON.stringify({ error: 'Session expired', message: 'Please re-upload your screenshots.' }) };

        const jobId = crypto.randomUUID().replace(/-/g, '').substring(0, 16);

        // Start generation — do NOT await, returns immediately
        runReportGeneration(jobId, sessionId, paymentId);

        return { statusCode: 202, headers, body: JSON.stringify({ jobId, status: 'processing' }) };

    } catch (err) {
        console.error('Handler error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
