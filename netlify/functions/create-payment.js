// LISTING LENS — Stripe Payment Intent
// Creates a PaymentIntent for the user's chosen amount: $2, $5, or $10 AUD.
// The amount is validated server-side — we only accept the three allowed values.

const ALLOWED_AMOUNTS = [200, 500, 1000]; // cents: $2, $5, $10

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

    try {
        const body = JSON.parse(event.body || '{}');

        // Validate amount — only accept the three defined options, default to $2
        const requestedAmount = parseInt(body.amount, 10);
        const amount = ALLOWED_AMOUNTS.includes(requestedAmount) ? requestedAmount : 200;

        const amountLabel = { 200: '$2.00', 500: '$5.00', 1000: '$10.00' }[amount] || '$2.00';

        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

        const paymentIntent = await stripe.paymentIntents.create({
            amount,
            currency: 'aud',
            automatic_payment_methods: { enabled: true },
            metadata: {
                product: 'listing_lens_report',
                chosen_amount: amountLabel,
                report_generated: 'false'
            }
        });

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                clientSecret: paymentIntent.client_secret,
                paymentIntentId: paymentIntent.id,
                amount,
                amountLabel
            })
        };
    } catch (error) {
        console.error('Stripe error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Payment setup failed', message: error.message })
        };
    }
};
