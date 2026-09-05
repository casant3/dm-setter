import { createSign } from "node:crypto";

/**
 * Fetching a Google Sheet tab as CSV.
 *
 * Two ways in, tried in order:
 *
 * 1. A service account, when `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
 *    `GOOGLE_PRIVATE_KEY` are set. The sheet is shared with that address, the
 *    way it would be shared with a colleague. Nothing is made public and the
 *    credential is read-only.
 * 2. The plain export endpoint, which works when the sheet is link-shared.
 *
 * The token is minted here with `node:crypto` rather than pulling in the Google
 * client libraries: it is one signed JWT exchanged for an access token, and a
 * dependency that large earns its place elsewhere, not here.
 */

export type SheetRef = { spreadsheetId: string; gid: string | null };

/** Pulls the spreadsheet id and tab id out of a Sheets URL, or accepts a bare id. */
export function parseSheetUrl(input: string): SheetRef | null {
  const text = input.trim();
  if (!text) return null;

  const byUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = byUrl?.[1] ?? (/^[a-zA-Z0-9-_]{20,}$/.test(text) ? text : null);
  if (!spreadsheetId) return null;

  const gid = text.match(/[#&?]gid=(\d+)/)?.[1] ?? null;
  return { spreadsheetId, gid };
}

export function serviceAccountConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

function privateKey(): string {
  // Hosting dashboards store the key with literal \n sequences.
  return (process.env.GOOGLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim();
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs a JWT and exchanges it for a read-only access token. */
async function accessToken(): Promise<string> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = privateKey();
  if (!email || !key) throw new Error("No Google service account is configured");

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = base64url(signer.sign(key));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${signature}`,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !payload.access_token) {
    throw new Error(
      `Google refused the service account: ${payload.error_description ?? res.status}. Check GOOGLE_PRIVATE_KEY is the full key including the BEGIN and END lines.`,
    );
  }
  return payload.access_token;
}

export type FetchedSheet = { csv: string; via: "service_account" | "public_link" };

/**
 * Downloads one tab as CSV.
 *
 * The export endpoint is used rather than the Sheets API because the sheet is a
 * grid rather than a table: the API returns values by range and would need the
 * tab's name, while the export returns exactly what a person would get from
 * File → Download → CSV.
 */
export async function fetchSheetCsv(ref: SheetRef): Promise<FetchedSheet> {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}/export`);
  url.searchParams.set("format", "csv");
  if (ref.gid) url.searchParams.set("gid", ref.gid);

  if (serviceAccountConfigured()) {
    const token = await accessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return { csv: await res.text(), via: "service_account" };
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `The service account cannot see that sheet. Share it (view access is enough) with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL}, then try again.`,
      );
    }
    throw new Error(`Google returned ${res.status} for that sheet.`);
  }

  const res = await fetch(url);
  if (res.ok) {
    const csv = await res.text();
    // An unshared sheet answers with a sign-in page rather than an error.
    if (/<html/i.test(csv.slice(0, 200))) {
      throw new Error(
        "That sheet is not readable without signing in. Either configure a Google service account and share the sheet with it, or paste the tab's contents instead.",
      );
    }
    return { csv, via: "public_link" };
  }
  throw new Error(
    `Could not read that sheet (${res.status}). Configure a Google service account and share the sheet with it, or paste the tab's contents instead.`,
  );
}
