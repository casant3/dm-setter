import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
const SESSION_TTL_SECONDS = 60 * 60 * 12;

export type AuthConfig = { passwordHash: string; salt: string; secret: string };

export function authConfigured(): boolean {
  return Boolean(process.env.APP_PASSWORD_HASH && process.env.APP_PASSWORD_SALT && process.env.SESSION_SECRET);
}

function config(): AuthConfig {
  const passwordHash = process.env.APP_PASSWORD_HASH;
  const salt = process.env.APP_PASSWORD_SALT;
  const secret = process.env.SESSION_SECRET;
  if (!passwordHash || !salt || !secret) {
    throw new Error("Auth is not configured. Run `npm run auth:setup` and set the printed values.");
  }
  return { passwordHash, salt, secret };
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

/** True when the current request carries a valid session. */
export async function isAuthenticated(): Promise<boolean> {
  if (!authConfigured()) return false;
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
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
      { error: "Authentication is not configured. Run `npm run auth:setup` and set APP_PASSWORD_HASH, APP_PASSWORD_SALT and SESSION_SECRET." },
      { status: 503 },
    );
  }

  return Response.json({ error: "Not authenticated" }, { status: 401 });
}
