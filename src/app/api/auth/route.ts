import { cookies } from "next/headers";
import { SESSION_COOKIE, authConfigured, createSessionToken, isAuthenticated, sessionCookieOptions, verifyPassword } from "@/lib/auth";
import { fail, handleError, ok, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ authenticated: await isAuthenticated(), configured: authConfigured() });
}

/** Sign in. Deliberately vague on failure so it cannot be used to probe config. */
export async function POST(request: Request) {
  try {
    if (!authConfigured()) {
      return fail("Authentication is not configured. Set APP_PASSWORD in the environment.", 503);
    }
    const { password } = await readJson<{ password?: string }>(request);
    if (!password || !verifyPassword(password)) {
      return fail("Incorrect password", 401);
    }
    const store = await cookies();
    store.set(SESSION_COOKIE, createSessionToken(), sessionCookieOptions);
    return ok({ authenticated: true });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  return ok({ authenticated: false });
}
