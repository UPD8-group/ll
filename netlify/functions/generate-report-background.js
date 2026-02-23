/**
 * LISTING LENS — Generate Report Background Worker
 *
 * Netlify background functions run for up to 15 minutes — plenty for Claude.
 * Called by generate-report.js, stores result in Blobs for report-status.js to return.
 *
 * Netlify automatically treats files ending in -background.js as background functions.
 */

const Anthropic    = require('@anthropic-ai/sdk');
const fs           = require('fs');
const path         = require('path');
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
    console.warn('Prompt not found:', filename);
    return null;
}

async function verifyPayment(paymentIntentId) {
    if (process.env.BETA_MODE === 'true') return { valid: true };
    if (!paymentIntentId) return { valid: false, reason: 'No payment intent ID' };

    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (intent.status !== 'succeeded')
            return { valid: false, reason: 'Payment status: ' + intent.status };
        if (![200, 500, 1000].includes(intent.amount))
            return { valid: false, reason: 'Invalid amount: ' + intent.amount };
        if (intent.currency !== 'aud')
            return { valid: false, reason: 'Wrong currency' };
        if (intent.metadata && intent.metadata.report_generated === 'true')
            return { valid: false, reason: 'Payment already used' };

        await stripe.paymentIntents.update(paymentIntentId, {
            metadata: Object.assign({}, intent.metadata, { report_generated: 'true' })
        });

        return { valid: true };
    } catch (err) {
        return { valid: false, reason: err.message };
    }
}

async function setJobStatus(store, jobId, data) {
    try { await store.setJSON(`job/${jobId}`, data); } catch (e) { console.error('setJobStatus failed:', e.message); }
}

exports.handler = async (event) => {
    // Background functions must return 202 immediately
    // Netlify keeps the function running after the response
    const store  = blobStore();
    let   jobId  = null;

    try {
        const body        = JSON.parse(event.body || '{}');
        jobId             = body.jobId;
        const sessionId   = body.sessionId;
        const paymentId   = body.paymentIntentId;

        if (!jobId || !sessionId) {
            console.error('Missing jobId or sessionId');
            return { statusCode: 202 };
        }

        await setJobStatus(store, jobId, { status: 'processing', startedAt: new Date().toISOString() });

        // --- Payment verification ---
        const payment = await verifyPayment(paymentId);
        if (!payment.valid) {
            await setJobStatus(store, jobId, { status: 'error', error: 'Payment failed: ' + payment.reason });
            return { statusCode: 202 };
        }

        // --- Load session metadata ---
        let meta;
        try { meta = await store.get(`${sessionId}/meta`, { type: 'json' }); } catch (_) { meta = null; }

        if (!meta) {
            await setJobStatus(store, jobId, { status: 'error', error: 'Session expired — please re-upload.' });
            return { statusCode: 202 };
        }

        const { category, screenshotCount } = meta;

        if (!VALID_CATEGORIES.includes(category)) {
            await setJobStatus(store, jobId, { status: 'error', error: 'Invalid category' });
            return { statusCode: 202 };
        }

        // --- Retrieve screenshots ---
        const screenshots = [];
        for (let i = 0; i < screenshotCount; i++) {
            try {
                const blob     = await store.get(`${sessionId}/screenshot-${i}`, { type: 'arrayBuffer' });
                const blobMeta = await store.getMetadata(`${sessionId}/screenshot-${i}`);
                if (blob) {
                    screenshots.push({
                        base64:   Buffer.from(blob).toString('base64'),
                        mimeType: (blobMeta && blobMeta.metadata && blobMeta.metadata.mimeType) || 'image/jpeg'
                    });
                }
            } catch (e) { console.warn(`Screenshot ${i} not found:`, e.message); }
        }

        if (screenshots.length === 0) {
            await setJobStatus(store, jobId, { status: 'error', error: 'Screenshots expired — please re-upload.' });
            return { statusCode: 202 };
        }

        // --- Load prompt ---
        // Use category-specific prompt if available, fall back to universal
        let systemPrompt = null;
        if (category === 'property')    systemPrompt = loadPrompt('combined-aus-property-v3.1.md');
        if (category === 'vehicle')     systemPrompt = loadPrompt('combined-aus-vehicle-v3.1.md');
        if (category === 'electronics') systemPrompt = loadPrompt('combined-aus-electronics-v3.1.md');
        if (category === 'other')       systemPrompt = loadPrompt('combined-aus-general-v3.1.md');
        if (!systemPrompt)              systemPrompt = loadPrompt('fast-universal-v1.md');

        if (!systemPrompt) {
            await setJobStatus(store, jobId, { status: 'error', error: 'Prompt configuration error' });
            return { statusCode: 202 };
        }

        const reportId = 'LL-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const today    = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

        systemPrompt += `\n\n---\nReport ID: ${reportId}\nDate: ${today}\nScreenshots: ${screenshots.length}\nCategory: ${category}\n\nIdentify country/jurisdiction from screenshots and adapt all costs, laws, and buyer rights accordingly.\n\nOutput ONLY valid HTML starting with <!DOCTYPE html>. No markdown, no code fences.`;

        const messageContent = [
            ...screenshots.map(s => ({
                type:   'image',
                source: { type: 'base64', media_type: s.mimeType, data: s.base64 }
            })),
            {
                type: 'text',
                text: `Analyse this ${category} listing and generate the complete Listing Lens buyer intelligence report as standalone HTML.`
            }
        ];

        // --- Call Claude (no timeout pressure) ---
        const client   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const response = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 8000,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: messageContent }]
        });

        let reportHtml = response.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');

        // Strip any accidental markdown fences
        reportHtml = reportHtml.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

        const docStart = reportHtml.indexOf('<!DOCTYPE html>') !== -1
            ? reportHtml.indexOf('<!DOCTYPE html>')
            : reportHtml.indexOf('<html');
        const docEnd = reportHtml.lastIndexOf('</html>');
        if (docStart !== -1 && docEnd !== -1) {
            reportHtml = reportHtml.substring(docStart, docEnd + 7);
        }

        // --- Store completed report ---
        await setJobStatus(store, jobId, {
            status:      'complete',
            reportId,
            html:        reportHtml,
            completedAt: new Date().toISOString()
        });

        // --- Clean up screenshots ---
        try {
            const deletes = [];
            for (let i = 0; i < screenshotCount; i++) deletes.push(store.delete(`${sessionId}/screenshot-${i}`));
            deletes.push(store.delete(`${sessionId}/meta`));
            await Promise.all(deletes);
        } catch (_) { /* best effort */ }

    } catch (error) {
        console.error('Background worker error:', error);
        if (jobId) {
            try {
                await blobStore().setJSON(`job/${jobId}`, { status: 'error', error: error.message || 'Unknown error' });
            } catch (_) { /* best effort */ }
        }
    }

    return { statusCode: 202 };
};
