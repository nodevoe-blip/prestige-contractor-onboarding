# prestige-contractor-onboarding

A single static page (`index.html`) served at `contractors.prestigeweddings.com`, plus a Cloudflare Worker (`worker/`) that receives its submission and emails it to Prestige via Microsoft Graph.

## What this collects, and why it's locked down

This form collects a new hire's SSN, date of birth, full mailing address, and bank routing/account number for direct deposit -- the most sensitive data anywhere in the Prestige app family. It used to be reachable by anyone on the internet with no authentication at all: the Worker URL is visible in this page's own client-side source, and the Worker accepted any POST from any origin and emailed whatever it was sent. That meant anyone could submit a fabricated SSN + bank account under any name and have it land in Prestige's inbox looking like a real hire's banking info -- a direct path to payroll/direct-deposit fraud.

It's now gated by a signed, expiring token:

1. An Applications admin marks a job applicant "Hired" in `prestige-applications` and clicks **Start Onboarding**. That page signs a short-lived (7-day) token naming that specific applicant (see `prestige-applications/src/lib/onboarding-link.ts`) and opens this page with `?token=<the token>` -- no name/email/phone in the URL anymore, just the opaque token.
2. This page decodes the token (without verifying it -- it can't, that needs the signing secret, which never ships to the browser) just to prefill the name/email/phone fields.
3. On submit, the token travels along with the rest of the form to the Worker, which verifies its signature and expiry before accepting anything. Without a valid token, the Worker rejects the submission outright, regardless of what's in the form.

**What this does NOT fix**: the submission's only destination is still an email. There's no database record, no retention policy, no access control beyond whoever can read that inbox. That's an accepted, separate gap for a later pass -- today's fix stops forgery, not where the data ultimately lives.

## Deploying the Worker

```bash
cd worker
npm install
npx wrangler login                       # one-time, opens a browser
npx wrangler secret put ONBOARDING_LINK_SECRET
npx wrangler secret put ALLOWED_ORIGIN    # https://contractors.prestigeweddings.com -- no wildcard
npx wrangler secret put TENANT_ID
npx wrangler secret put CLIENT_ID
npx wrangler secret put CLIENT_SECRET
npx wrangler secret put SEND_AS_USER
npx wrangler secret put NOTIFY_EMAIL
npx wrangler deploy
```

Values to use -- **reuse these, don't mint anything new**:

- `ONBOARDING_LINK_SECRET` -- generate a fresh random value and use it for BOTH this secret and `prestige-applications`'s `ONBOARDING_LINK_SECRET` env var (Vercel). They must match exactly, or every token this Worker sees will fail verification.
- `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SEND_AS_USER`, `NOTIFY_EMAIL` -- copy the values of `MS_TENANT_ID`, `MS_MAIL_CLIENT_ID`, `MS_MAIL_CLIENT_SECRET`, `MS_SEND_AS_USER`, `NOTIFY_EMAIL` straight out of `prestige-applications/.env`. This is the same mail-sending Azure app registration already used across the family (Applications, Boothprep, Coordination Tracker) -- Azure caps how many client secrets one registration can have, so don't generate a new one here.

Wrangler prints the deployed Worker's URL (something like `https://prestige-contractor-onboarding.<account>.workers.dev`). Paste that into `WORKER_URL` near the top of `index.html`'s `<script>`, then redeploy the static page to wherever it's hosted.

**Once the new Worker is live and `index.html` points at it**, find and delete the old Worker (the one at `snowy-waterfall-4ad5.devoeconsults.workers.dev`) from the Cloudflare dashboard -- it still has no authentication on it and will keep accepting forged submissions for as long as it exists, token or no token.

## Local development

```bash
cd worker
npx wrangler dev
```

Then point `index.html`'s `WORKER_URL` at the printed local URL (`http://localhost:8787` by default) while testing, and back at the real deployed URL before shipping.
