// LISTING LENS — Client Config
// Safely exposes non-secret config (like Stripe publishable key) to the frontend

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            stripePk: process.env.STRIPE_PUBLISHABLE_KEY || '',
            betaMode: process.env.BETA_MODE === 'true'
        })
    };
};
