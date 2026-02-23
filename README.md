# Listing Lens

Buyer intelligence for marketplace listings. Upload screenshots, get a report.

## Architecture

```
public/ (static HTML) → Netlify Functions → Claude API (web search) + Stripe
```

No frameworks. No build step. No database. Stateless, privacy-first.

## Setup

### 1. Environment Variables

Set these in Netlify UI → **Site settings → Environment variables**:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_...` or `sk_test_...`) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (`pk_live_...` or `pk_test_...`) |
| `BETA_MODE` | Set to `true` to skip payment during testing |

### 2. Deploy

1. Push to GitHub
2. Connect repo to Netlify (auto-detects `netlify.toml`)
3. Set environment variables above
4. Assign your domain (`listinglens.app`)
5. Test with `BETA_MODE=true` first — confirms Claude API works end-to-end

## How the Frontend Gets the Stripe Key

The Stripe **publishable** key (safe to expose to browsers) is served via `/api/config`
so it never needs to be hardcoded in HTML. The dashboard calls this endpoint on
boot and initialises Stripe from the response.

## Payment Verification

`generate-report.js` verifies every payment intent before generating:
- Status must be `succeeded`
- Amount must be exactly 200 cents (AUD $2)
- Currency must be `aud`
- Marks the intent as `report_generated: true` to prevent replay attacks

## File Structure

```
public/           ← Netlify publish directory (the live site)
  index.html      ← Landing page
  dashboard.html  ← Upload + payment + report viewer
  privacy.html
  terms.html
  why.html
  404.html

netlify/functions/
  config.js           ← Returns Stripe PK + beta mode flag to frontend
  create-payment.js   ← Creates Stripe PaymentIntent ($2 AUD)
  generate-report.js  ← Verifies payment, calls Claude API, returns HTML report

prompts/
  LISTING-LENS-REPORT-SPEC.md         ← Master report spec (HTML output)
  combined-aus-property-v3.1.md       ← Full property analysis prompt
  combined-aus-vehicle-v3.1.md        ← Full vehicle analysis prompt (car)
  category-{bike,boat,truck,...}.md   ← Category stubs (see note below)
  country-australia.md                ← Australian context layer
  master.md                           ← Legacy master prompt
```

## Categories

**Full prompts (production ready):**
- Car → `combined-aus-vehicle-v3.1.md`
- Property → `combined-aus-property-v3.1.md`
- Apartment → `combined-aus-property-v3.1.md`

**Stub prompts (functional but generic):**
- Motorbike, Truck, Boat, Caravan, Farm, Construction, Land

Stub categories use the vehicle prompt + their category stub. The API marks them
as early access in the output instructions so Claude compensates with extra rigour.
Consider fleshing these out or marking them "coming soon" in the dashboard before
driving significant traffic.

## Report Format

All reports are generated as standalone HTML files with embedded CSS.
The dashboard renders them in a sandboxed `<iframe>` and measures the true
content height after load to avoid scroll issues.

## V2 Roadmap

**PPSR Integration (vehicles)**
Current: Reports tell buyers to run their own PPSR check.
V2: Integrate PPSR results directly — finance encumbrances, write-off history,
stolen status, VIN verification. Partner with PPSR.com.au or similar broker.
Requires VIN/rego input field on the dashboard upload screen.

**Other V2:**
- Dedicated prompts for boat, caravan, farm equipment
- PDF export option
- Shareable report links with expiry
- NZ country layer
