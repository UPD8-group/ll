/**
 * LISTING LENS — Generate Report
 *
 * Retrieves screenshots from Upstash Redis (stored by upload-screenshots),
 * verifies payment, generates the report via Claude API,
 * then immediately deletes screenshots from Redis.
 *
 * Route: POST /api/generate-report
 * Body: JSON { sessionId, paymentIntentId }
 *
 * Returns: { format: 'html', reportId, html }
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const store     = require('./lib/store');

const VALID_CATEGORIES = ['vehicle','property','electronics','other'];
// No stub categories — all four are fully supported

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

        // Retrieve session from Redis
        const session = await store.getSession(sessionId);
        if (!session) {
            return {
                statusCode: 410,
                headers,
                body: JSON.stringify({
                    error: 'Session expired',
                    message: 'Your screenshots have been automatically deleted (15-minute limit). Please upload again.'
                })
            };
        }

        const category       = session.category;
        const screenshotCount = session.screenshotCount;

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

        // Retrieve screenshots from Redis
        const screenshotPromises = [];
        for (let i = 0; i < screenshotCount; i++) {
            screenshotPromises.push(store.getScreenshot(sessionId, i));
        }
        const screenshots = (await Promise.all(screenshotPromises)).filter(Boolean);

        if (screenshots.length === 0) {
            return {
                statusCode: 410,
                headers,
                body: JSON.stringify({
                    error: 'Screenshots expired',
                    message: 'Your screenshots were automatically deleted before the report could be generated. Please upload again — your payment is still valid.'
                })
            };
        }

        // Build system prompt based on top-level category
        let systemPrompt = '';

        if (category === 'property') {
            systemPrompt = loadPrompt('combined-aus-property-v3.1.md');
        } else if (category === 'vehicle') {
            systemPrompt = loadPrompt('combined-aus-vehicle-v3.1.md');
        } else if (category === 'electronics') {
            systemPrompt = loadPrompt('combined-aus-electronics-v1.md');
        } else {
            // 'other' — general marketplace intelligence
            systemPrompt = loadPrompt('combined-aus-general-v1.md');
        }

        // Fallback: if specialist prompt not found, use vehicle prompt as base
        if (!systemPrompt) {
            systemPrompt = loadPrompt('combined-aus-vehicle-v3.1.md');
        }

        if (!systemPrompt)
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Prompt configuration error' }) };

        const reportId = 'LL-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        const today    = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
        const isStub   = false; // All categories are fully supported

        systemPrompt += '\n\n---\n\nOUTPUT INSTRUCTIONS:\n\nGenerate the complete report as a standalone HTML file. Include all CSS in a <style> tag.\n\nReport ID: ' + reportId + '\nDate: ' + today + '\nScreenshots: ' + screenshots.length + '\nCategory: ' + category + (isStub ? '\n\nNOTE: Early-access category. Apply full analysis with extra rigour for category-specific risks.' : '') + '\n\nIdentify country/jurisdiction from screenshots. Adapt all costs, laws, and buyer rights to local market.\n\nOutput ONLY the HTML. No markdown, no code fences. Start with <!DOCTYPE html>.';

        const messageContent = [
            ...screenshots.map(function(s) {
                return {
                    type: 'image',
                    source: { type: 'base64', media_type: s.mimeType || 'image/jpeg', data: s.base64 }
                };
            }),
            {
                type: 'text',
                text: 'The customer has uploaded ' + screenshots.length + ' screenshot(s) of a ' + category + ' listing. Analyse thoroughly and generate the complete Listing Lens buyer intelligence report as standalone HTML.'
            }
        ];

        const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const response = await client.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 16000,
            system:     systemPrompt,
            tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
            messages:   [{ role: 'user', content: messageContent }]
        });

        let reportHtml = response.content
            .filter(function(b) { return b.type === 'text'; })
            .map(function(b) { return b.text; })
            .join('');

        reportHtml = reportHtml.replace(/```html\n?/g, '').replace(/```\n?/g, '').trim();

        const docStart = reportHtml.indexOf('<!DOCTYPE html>') !== -1
            ? reportHtml.indexOf('<!DOCTYPE html>')
            : reportHtml.indexOf('<html');
        const docEnd = reportHtml.lastIndexOf('</html>');

        if (docStart !== -1 && docEnd !== -1) {
            reportHtml = reportHtml.substring(docStart, docEnd + 7);
        }

        // Immediately delete screenshots and session — don't wait for TTL
        try {
            await Promise.all([
                store.deleteScreenshots(sessionId, screenshotCount),
                store.deleteSession(sessionId)
            ]);
            console.log('Session ' + sessionId + ': screenshots deleted immediately after report generation');
        } catch (cleanupErr) {
            console.error('Session ' + sessionId + ': cleanup error (screenshots will auto-expire at 15 min):', cleanupErr);
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ format: 'html', reportId: reportId, html: reportHtml })
        };

    } catch (error) {
        console.error('Report generation error:', error);

        if (sessionId) {
            try {
                const session = await store.getSession(sessionId);
                if (session) {
                    await Promise.all([
                        store.deleteScreenshots(sessionId, session.screenshotCount || 6),
                        store.deleteSession(sessionId)
                    ]);
                }
            } catch (_) { /* best effort cleanup */ }
        }

        return {
            statusCode: 500, headers,
            body: JSON.stringify({ error: 'Failed to generate report', message: error.message })
        };
    }
};
