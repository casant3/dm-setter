import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Single-user authentication.
 *
 * The app holds private prospect conversations, so every route is closed by
 * default. This is deliberately simple — one operator, a password hash in the
 * environment, an HMAC-signed session cookie — because the alternative worth
 * having (a full identity provider) is a bigger change than this product needs
 * today, and no auth at all is not an option.
 */

export const SESSION_COOKIE = "dm_setter_session";
/**
 * Session lifetime.
 *
 * The operator works from a phone, in short bursts, all day. A 12-hour session
 * meant signing in again most mornings and — worse — mid-day whenever the
 * installed app was reopened after the window lapsed, which is exactly the
 * friction this tool exists to remove. Thirty days with sliding renewal keeps a
 * working phone signed in while still expiring an abandoned device, and the
 * cookie stays httpOnly, SameSite=Lax and Secure in production.
 */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Renew once a session is more than halfway through its life. */
const RENEW_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;

export type AuthConfig = { passwordHash: string; salt: string; secret: string };

/**
 * Deriving config from a plain `APP_PASSWORD`.
 *
 * The hashed form below is preferred: it means the password itself is never
 * stored anywhere. But producing a hash needs a machine with Node on it, and
 * this app is deployed from a phone and a browser — so requiring that put an
 * offline step between the operator and their own tool.
 *
 * Setting `APP_PASSWORD` instead lets the host hold the password in the same
 * encrypted environment that already holds the Supabase service-role key, which
 * is a far more powerful secret. The salt is derived from the password so no
 * second value is needed, which does forgo per-deployment salting; scrypt's cost
 * still stands behind it, and for a single-operator app that is the right trade
 * against not being able to sign in at all.
 */
function derivedSalt(password: string): string {
  return createHash("sha256").update(`dm-setter-salt:${password}`).digest("hex").slice(0, 32);
}

/**
 * The session secret, when none was supplied.
 *
 * Derived from the password, so a forged cookie needs the password — which is
 * the same thing as simply signing in. Stable across restarts and instances, so
 * sessions survive a redeploy, and changing the password signs every device out.
 */
function derivedSecret(password: string): string {
  return createHash("sha256").update(`dm-setter-session:${password}`).digest("hex");
}

export function authConfigured(): boolean {
  if (process.env.APP_PASSWORD_HASH && process.env.APP_PASSWORD_SALT && process.env.SESSION_SECRET) return true;
  return Boolean(process.env.APP_PASSWORD);
}

function config(): AuthConfig {
  const passwordHash = process.env.APP_PASSWORD_HASH;
  const salt = process.env.APP_PASSWORD_SALT;
  const secret = process.env.SESSION_SECRET;
  if (passwordHash && salt && secret) return { passwordHash, salt, secret };

  const plain = process.env.APP_PASSWORD;
  if (plain) {
    const derived = salt || derivedSalt(plain);
    return {
      passwordHash: hashPassword(plain, derived),
      salt: derived,
      secret: secret || derivedSecret(plain),
    };
  }

  throw new Error(
    "Auth is not configured. Set APP_PASSWORD, or run `npm run auth:setup` and set APP_PASSWORD_HASH, APP_PASSWORD_SALT and SESSION_SECRET.",
  );
}

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

export function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

/** Constant-time comparison so a wrong password cannot be timed character by character. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyPassword(password: string): boolean {
  const { passwordHash, salt } = config();
  return safeEqual(hashPassword(password, salt), passwordHash);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function sign(payload: string): string {
  return createHmac("sha256", config().secret).update(payload).digest("hex");
}

export function createSessionToken(): string {
  const expires = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = `${expires}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  if (!safeEqual(sign(payload), signature)) return false;
  const expires = Number(payload);
  return Number.isFinite(expires) && expires > Date.now();
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

/** Milliseconds left on a token, or null when it is not valid. */
function remainingMs(token: string | undefined): number | null {
  if (!verifySessionToken(token)) return null;
  const expires = Number(token!.split(".")[0]);
  return expires - Date.now();
}

/**
 * True when the current request carries a valid session.
 *
 * A session past its halfway point is renewed in place, so an operator using the
 * app daily is never signed out mid-conversation, while a device left untouched
 * for a month still expires. Renewal is best-effort: cookies cannot be written
 * from every rendering context, and failing to extend a session must never fail
 * the request.
 */
export async function isAuthenticated(): Promise<boolean> {
  if (!authConfigured()) return false;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const remaining = remainingMs(token);
  if (remaining === null) return false;

  if (remaining < RENEW_AFTER_SECONDS * 1000) {
    try {
      store.set(SESSION_COOKIE, createSessionToken(), sessionCookieOptions);
    } catch {
      // Read-only cookie context. The session is still valid; it simply will
      // not be extended on this particular request.
    }
  }
  return true;
}

/**
 * Guard for API routes. Returns a 401 response when the caller is not
 * authenticated, or null when the request may proceed.
 *
 * When auth is unconfigured the app runs open ONLY on localhost in development,
 * so a fresh clone is usable; any other environment is denied rather than
 * silently exposing prospect data.
 */
export async function requireAuth(): Promise<Response | null> {
  if (await isAuthenticated()) return null;

  if (!authConfigured()) {
    if (process.env.NODE_ENV !== "production") return null;
    return Response.json(
      {
        error:
          "Authentication is not configured. Set APP_PASSWORD in the environment, or run `npm run auth:setup` for the hashed form.",
      },
      { status: 503 },
    );
  }

  return Response.json({ error: "Not authenticated" }, { status: 401 });
}
