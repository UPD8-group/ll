/**
 * LISTING LENS — Generate Report (Netlify Blobs version)
 *
 * Retrieves screenshots from Netlify Blobs (stored by upload-screenshots),
 * verifies payment, generates the report via Claude API,
 * then immediately deletes screenshots from Blobs.
 *
 * Route: POST /api/generate-report
 * Body: JSON { sessionId, paymentIntentId }
 *
 * Returns: { format: 'html', reportId, html }
 */

const Anthropic   = require('@anthropic-ai/sdk');
const fs          = require('fs');
const path        = require('path');
const { getStore } = require('@netlify/blobs');

const VALID_CATEGORIES = ['vehicle','property','electronics','other'];

function loadPrompt(filename) {
    const locations = [
        path.join(process.cwd(), 'prompts', filename),
        path.join(__dirname, '..', '..', 'prompts', filename),
        path.join(__dirname, 'prompts', filename)
    ];
    for (const p of locations) {
        try { return fs.readFileSync(p, 'utf-8'); } catch { /* try next */ }
    }
    console.warn('Prompt not found: ' + filename);
    return '';
}

async function verifyPayment(paymentIntentId) {
    if (process.env.BETA_MODE === 'true') return { valid: true, reason: 'beta' };
    if (!paymentIntentId) return { valid: false, reason: 'No payment intent ID' };

    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (intent.status !== 'succeeded')
            return { valid: false, reason: 'Payment status: ' + intent.status };
        if (![200, 500, 1000].includes(intent.amount))
            return { valid: false, reason: 'Invalid amount: ' + intent.amount };
        if (intent.currency !== 'aud')
            return { valid: false, reason: 'Wrong currency: ' + intent.currency };
        if (intent.metadata && intent.metadata.report_generated === 'true')
            return { valid: false, reason: 'Payment already used' };

        await stripe.paymentIntents.update(paymentIntentId, {
            metadata: Object.assign({}, intent.metadata, { report_generated: 'true' })
        });

        return { valid: true };
    } catch (err) {
        console.error('Payment verification error:', err);
        return { valid: false, reason: err.message };
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

    let sessionId = null;

    try {
        const body = JSON.parse(event.body || '{}');
        sessionId = body.sessionId;
        const paymentIntentId = body.paymentIntentId;

        if (!sessionId)
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'sessionId required' }) };

        // Retrieve session metadata from Blobs
        const store = getStore('listing-lens-sessions');
        const meta  = await store.get(`${sessionId}/meta`, { type: 'json' });

        if (!meta) {
            return {
                statusCode: 410, headers,
                body: JSON.stringify({
                    error: 'Session expired',
                    message: 'Your screenshots have been automatically deleted (15-minute limit). Please upload again.'
                })
            };
        }

        // Check expiry manually
        if (new Date(meta.expiresAt) < new Date()) {
            await store.delete(`${sessionId}/meta`);
            return {
                statusCode: 410, headers,
                body: JSON.stringify({
                    error: 'Session expired',
                    message: 'Your session has expired. Please upload again.'
                })
            };
        }

        const category       = meta.category;
        const screenshotCount = meta.screenshotCount;

        if (!VALID_CATEGORIES.includes(category))
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid category in session' }) };

        // Verify payment before expensive work
        const payment = await verifyPayment(paymentIntentId);
        if (!payment.valid) {
            return {
                statusCode: 402, headers,
                body: JSON.stringify({ error: 'Payment verification failed', reason: payment.reason })
            };
        }

        // Retrieve screenshots from Blobs
        const screenshots = [];
        for (let i = 0; i < screenshotCount; i++) {
            try {
                const blob     = await store.get(`${sessionId}/screenshot-${i}`, { type: 'arrayBuffer' });
                const blobMeta = await store.getMetadata(`${sessionId}/screenshot-${i}`);
                if (blob) {
                    screenshots.push({
                        base64:   Buffer.from(blob).toString('base64'),
                        mimeType: blobMeta?.metadata?.mimeType || 'image/jpeg'
                    });
                }
            } catch (e) {
                console.warn(`Screenshot ${i} not found:`, e.message);
            }
        }

        if (screenshots.length === 0) {
            return {
                statusCode: 410, headers,
                body: JSON.stringify({
                    error: 'Screenshots expired',
                    message: 'Your screenshots were automatically deleted before the report could be generated. Please upload again — your payment is still valid.'
                })
            };
        }

        // Load system prompt for category
        let systemPrompt = '';
        if      (category === 'property')    systemPrompt = loadPrompt('combined-aus-property-v3.1.md');
        else if (category === 'vehicle')     systemPrompt = loadPrompt('combined-aus-vehicle-v3.1.md');
        else if (category === 'electronics') systemPrompt = loadPrompt('combined-aus-electronics-v1.md');
        else                                 systemPrompt = loadPrompt('combined-aus-general-v1.md');

        if (!systemPrompt) systemPrompt = loadPrompt('combined-aus-vehicle-v3.1.md');
        if (!systemPrompt)
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Prompt configuration error' }) };

        const reportId = 'LL-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const today    = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

        systemPrompt += `\n\n---\n\nOUTPUT INSTRUCTIONS:\n\nGenerate the complete report as a standalone HTML file. Include all CSS in a <style> tag.\n\nReport ID: ${reportId}\nDate: ${today}\nScreenshots: ${screenshots.length}\nCategory: ${category}\n\nIdentify country/jurisdiction from screenshots. Adapt all costs, laws, and buyer rights to local market.\n\nOutput ONLY the HTML. No markdown, no code fences. Start with <!DOCTYPE html>.`;

        const messageContent = [
            ...screenshots.map(s => ({
                type:   'image',
                source: { type: 'base64', media_type: s.mimeType, data: s.base64 }
            })),
            {
                type: 'text',
                text: `The customer has uploaded ${screenshots.length} screenshot(s) of a ${category} listing. Analyse thoroughly and generate the complete Listing Lens buyer intelligence report as standalone HTML.`
            }
        ];

        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 16000,
            system:     systemPrompt,
            tools:      [], // web search disabled — re-enable once on background functions
            messages:   [{ role: 'user', content: messageContent }]
        });

        let reportHtml = response.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');

        reportHtml = reportHtml.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

        const docStart = reportHtml.indexOf('<!DOCTYPE html>') !== -1
            ? reportHtml.indexOf('<!DOCTYPE html>')
            : reportHtml.indexOf('<html');
        const docEnd = reportHtml.lastIndexOf('</html>');

        if (docStart !== -1 && docEnd !== -1) {
            reportHtml = reportHtml.substring(docStart, docEnd + 7);
        }

        // Immediately delete all blobs for this session
        try {
            const deletePromises = [];
            for (let i = 0; i < screenshotCount; i++) {
                deletePromises.push(store.delete(`${sessionId}/screenshot-${i}`));
            }
            deletePromises.push(store.delete(`${sessionId}/meta`));
            await Promise.all(deletePromises);
            console.log(`Session ${sessionId}: blobs deleted after report generation`);
        } catch (cleanupErr) {
            console.error(`Session ${sessionId}: blob cleanup error:`, cleanupErr.message);
        }

        return {
            statusCode: 200, headers,
            body: JSON.stringify({ format: 'html', reportId, html: reportHtml })
        };

    } catch (error) {
        console.error('Report generation error:', error);

        // Best-effort cleanup on error
        if (sessionId) {
            try {
                const store = getStore('listing-lens-sessions');
                const meta  = await store.get(`${sessionId}/meta`, { type: 'json' });
                if (meta) {
                    const deletePromises = [];
                    for (let i = 0; i < (meta.screenshotCount || 6); i++) {
                        deletePromises.push(store.delete(`${sessionId}/screenshot-${i}`));
                    }
                    deletePromises.push(store.delete(`${sessionId}/meta`));
                    await Promise.all(deletePromises);
                }
            } catch (_) { /* best effort */ }
        }

        return {
            statusCode: 500, headers,
            body: JSON.stringify({ error: 'Failed to generate report', message: error.message })
        };
    }
};
