/**
 * LISTING LENS — Report Status (Polling)
 *
 * Frontend polls this every 3 seconds to check if the background
 * worker has finished generating the report.
 *
 * Route: GET /api/report-status?jobId=xxx
 * Returns: { status: 'queued' | 'processing' | 'complete' | 'error', html?, reportId?, error? }
 */

const { getStore } = require('@netlify/blobs');

const SITE_ID = '723a91f3-c306-48fd-b0d7-382ba89fb9a0';

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    const jobId = event.queryStringParameters && event.queryStringParameters.jobId;

    if (!jobId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'jobId required' }) };
    }

    try {
        const store = getStore({ name: 'listing-lens-sessions', siteID: SITE_ID, token: process.env.NETLIFY_TOKEN });

        let job;
        try {
            job = await store.get(`job/${jobId}`, { type: 'json' });
        } catch (_) {
            job = null;
        }

        if (!job) {
            // No job record yet — background function may not have started
            return { statusCode: 200, headers, body: JSON.stringify({ status: 'processing' }) };
        }

        // Clean up the job blob after delivering the result
        if (job.status === 'complete' || job.status === 'error') {
            try { await store.delete(`job/${jobId}`); } catch (_) {}
        }

        return { statusCode: 200, headers, body: JSON.stringify(job) };

    } catch (err) {
        console.error('Status check error:', err);
        return {
            statusCode: 500, headers,
            body: JSON.stringify({ status: 'error', error: err.message })
        };
    }
};
