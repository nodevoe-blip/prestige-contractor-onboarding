// Prestige Contractor Onboarding — Intake Worker
//
// Replaces an earlier Worker at this same job that accepted this exact
// payload shape (name, DOB, SSN, bank routing/account) from ANY origin,
// from ANYONE, with no authentication at all -- confirmed by its sibling
// prestige-invoice-email Worker's identical architecture and
// Access-Control-Allow-Origin: "*". That meant anyone who found this
// Worker's URL (visible in the onboarding page's own client-side source)
// could submit a fabricated SSN + bank account under any name and have
// it emailed straight into Prestige's inbox as if it were a real hire's
// banking change -- a direct path to payroll/direct-deposit fraud.
//
// This version requires a signed, expiring token minted server-side by
// prestige-applications (see its lib/onboarding-link.ts) when an admin
// marks a specific applicant "Hired" and clicks "Start Onboarding" --
// nobody can submit without one, and a token is only ever good for the
// applicant it names.
//
// Still true here, same as the invoice Worker: no persistent storage.
// Submissions only ever become an email. That's an accepted, separate
// gap (see this repo's README) -- today's fix is "nobody can forge a
// submission anymore," not "this data now lives somewhere better than
// an inbox." Don't try to close that second gap by bolting storage onto
// this Worker without a real plan for who can read it.

import { jwtVerify } from "jose";

export interface Env {
  ONBOARDING_LINK_SECRET: string; // same value as prestige-applications' ONBOARDING_LINK_SECRET
  ALLOWED_ORIGIN: string; // e.g. https://contractors.prestigeweddings.com -- no wildcard
  TENANT_ID: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  SEND_AS_USER: string;
  NOTIFY_EMAIL: string;
}

type OnboardingPayload = {
  token: string;
  // Anti-bot, same convention as prestige-applications' public apply form:
  // a real applicant never fills the honeypot, and never submits within a
  // few seconds of the page loading.
  honeypot: string;
  startedAt: number;
  personal: { firstName: string; lastName: string; email: string; phone: string; altPhone: string };
  address: { street: string; city: string; state: string; zip: string };
  identification: { dob: string; ssn: string };
  experience: { yearBegan: string; eventsServiced: string; eventTypes: string[] };
  services: string[];
  banking: { bankName: string; accountType: string; routing: string; account: string };
};

type OnboardingTokenPayload = {
  applicationId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getGraphToken(env: Env): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Required, non-empty string fields. (confirmAccount is intentionally not
// part of this payload at all -- it's a client-side-only double-entry
// check; sending it over the wire too would just be another copy of the
// account number to leak.)
const REQUIRED_STRINGS: [key: string, path: string[]][] = [
  ["firstName", ["personal", "firstName"]],
  ["lastName", ["personal", "lastName"]],
  ["email", ["personal", "email"]],
  ["phone", ["personal", "phone"]],
  ["street", ["address", "street"]],
  ["city", ["address", "city"]],
  ["state", ["address", "state"]],
  ["zip", ["address", "zip"]],
  ["dob", ["identification", "dob"]],
  ["ssn", ["identification", "ssn"]],
  ["bankName", ["banking", "bankName"]],
  ["routing", ["banking", "routing"]],
  ["account", ["banking", "account"]],
];

function getPath(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function validatePayload(payload: OnboardingPayload): string | null {
  for (const [label, path] of REQUIRED_STRINGS) {
    const value = getPath(payload, path);
    if (typeof value !== "string" || value.trim().length === 0) {
      return `Missing required field: ${label}`;
    }
  }
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(payload.identification.dob)) return "Date of birth isn't in MM/DD/YYYY format.";
  if (!/^\d{3}-\d{2}-\d{4}$/.test(payload.identification.ssn)) return "SSN isn't in XXX-XX-XXXX format.";
  if (!/^\d{9}$/.test(payload.banking.routing)) return "Routing number must be exactly 9 digits.";
  if (!Array.isArray(payload.services) || payload.services.length === 0) return "Select at least one service.";
  return null;
}

function buildEmailHtml(payload: OnboardingPayload, applicationId: string | null): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:8px 12px;font-size:13px;color:#666;width:170px;vertical-align:top;border-bottom:1px solid #eee">${escapeHtml(label)}</td>` +
    `<td style="padding:8px 12px;font-size:13px;color:#222;font-weight:500;border-bottom:1px solid #eee">${escapeHtml(value)}</td></tr>`;
  const section = (title: string) =>
    `<tr><td colspan="2" style="padding:10px 12px 6px;font-size:11px;font-weight:700;color:#0f3a5c;text-transform:uppercase;letter-spacing:.07em;background:#eef3f7;border-left:3px solid #8fa8c0">${escapeHtml(title)}</td></tr>`;

  const { personal, address, identification, experience, services, banking } = payload;

  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:10px;overflow:hidden">
    <div style="background:#7a1a1a;padding:10px 24px;color:white;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">
      Contains SSN and bank account details -- handle and store accordingly
    </div>
    <div style="background:#0f3a5c;padding:20px 24px">
      <div style="color:#8fa8c0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Prestige Weddings &amp; Events</div>
      <div style="color:white;font-size:16px;font-weight:700">New Contractor Onboarding Submission</div>
      ${applicationId ? `<div style="color:rgba(255,255,255,.6);font-size:11px;margin-top:2px">Linked application: ${escapeHtml(applicationId)}</div>` : ""}
    </div>
    <table style="width:100%;border-collapse:collapse">
      ${section("Personal")}
      ${row("Name", `${personal.firstName} ${personal.lastName}`)}
      ${row("Email", personal.email)}
      ${row("Phone", personal.phone)}
      ${personal.altPhone ? row("Alternate phone", personal.altPhone) : ""}
      ${section("Mailing Address")}
      ${row("Street", address.street)}
      ${row("City / State / ZIP", `${address.city}, ${address.state} ${address.zip}`)}
      ${section("Identification & Tax")}
      ${row("Date of birth", identification.dob)}
      ${row("SSN", identification.ssn)}
      ${section("Experience")}
      ${experience.yearBegan ? row("Year began", experience.yearBegan) : ""}
      ${experience.eventsServiced ? row("Events serviced (est.)", experience.eventsServiced) : ""}
      ${row("Services", services.join(", "))}
      ${section("Banking")}
      ${row("Bank name", banking.bankName)}
      ${row("Account type", banking.accountType)}
      ${row("Routing number", banking.routing)}
      ${row("Account number", banking.account)}
    </table>
    <div style="padding:14px 24px;background:#faf8f5;font-size:11px;color:#999;border-top:1px solid #eee">
      Prestige Weddings &amp; Events &nbsp;·&nbsp; Contractor Onboarding
    </div>
  </div>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 200, headers: corsHeaders(env) });
    }
    if (request.method !== "POST") {
      return json({ success: false, error: "Method not allowed" }, 405, env);
    }

    let payload: OnboardingPayload;
    try {
      payload = await request.json();
    } catch {
      return json({ success: false, error: "Invalid JSON" }, 400, env);
    }

    // Silently "succeed" on a tripped honeypot so a bot doesn't learn it
    // was caught -- never reaches the email step.
    if (payload.honeypot) {
      return json({ success: true }, 200, env);
    }
    if (!payload.startedAt || Date.now() - payload.startedAt < 3000) {
      return json({ success: false, error: "Something went wrong -- please try again." }, 400, env);
    }

    let tokenPayload: OnboardingTokenPayload;
    try {
      const secret = new TextEncoder().encode(env.ONBOARDING_LINK_SECRET);
      const { payload: verified } = await jwtVerify(payload.token, secret);
      tokenPayload = verified as unknown as OnboardingTokenPayload;
    } catch {
      return json(
        { success: false, error: "This onboarding link is invalid or has expired. Ask Prestige to send a new one." },
        401,
        env
      );
    }

    const validationError = validatePayload(payload);
    if (validationError) {
      return json({ success: false, error: validationError }, 400, env);
    }

    try {
      const graphToken = await getGraphToken(env);
      const emailRes = await fetch(`https://graph.microsoft.com/v1.0/users/${env.SEND_AS_USER}/sendMail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: `Contractor Onboarding: ${payload.personal.firstName} ${payload.personal.lastName}`,
            body: { contentType: "HTML", content: buildEmailHtml(payload, tokenPayload.applicationId) },
            toRecipients: [{ emailAddress: { address: env.NOTIFY_EMAIL } }],
            replyTo: [{ emailAddress: { address: payload.personal.email } }],
          },
          saveToSentItems: true,
        }),
      });
      if (!emailRes.ok) {
        const text = await emailRes.text().catch(() => "");
        throw new Error(`Graph sendMail failed: ${emailRes.status} ${text.slice(0, 300)}`);
      }
      return json({ success: true }, 200, env);
    } catch (err) {
      // Deliberately generic -- never echo submitted PII back in an error
      // response or let a thrown error carry it into Cloudflare's logs.
      console.error("Onboarding submission failed to send", err instanceof Error ? err.message : err);
      return json({ success: false, error: "Failed to send your submission. Please retry." }, 502, env);
    }
  },
};
