import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { authConfigured, createSessionToken, generateSalt, hashPassword, verifyPassword, verifySessionToken } from "@/lib/auth";

/**
 * Single-operator authentication.
 *
 * Two ways to configure it: a pre-computed hash, which keeps the password out
 * of the environment entirely, or a plain `APP_PASSWORD` for a host where
 * running a hashing script first is not practical. Both must actually protect
 * the app; neither may accidentally open it.
 */

const ENV_KEYS = ["APP_PASSWORD", "APP_PASSWORD_HASH", "APP_PASSWORD_SALT", "SESSION_SECRET"] as const;

function clearAuthEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(clearAuthEnv);

test("with nothing configured, auth is not configured", () => {
  clearAuthEnv();
  assert.equal(authConfigured(), false);
});

test("a partial hashed configuration does not count as configured", () => {
  clearAuthEnv();
  process.env.APP_PASSWORD_HASH = "abc";
  process.env.APP_PASSWORD_SALT = "def";
  // No SESSION_SECRET: sessions could not be signed, so this is not usable.
  assert.equal(authConfigured(), false);
});

test("the hashed configuration verifies the right password and only that one", () => {
  clearAuthEnv();
  const salt = generateSalt();
  process.env.APP_PASSWORD_SALT = salt;
  process.env.APP_PASSWORD_HASH = hashPassword("correct horse battery staple", salt);
  process.env.SESSION_SECRET = "a-secret-value";

  assert.equal(authConfigured(), true);
  assert.equal(verifyPassword("correct horse battery staple"), true);
  assert.equal(verifyPassword("Correct horse battery staple"), false);
  assert.equal(verifyPassword(""), false);
});

test("a plain APP_PASSWORD is enough to configure auth", () => {
  clearAuthEnv();
  process.env.APP_PASSWORD = "a-long-enough-password";

  assert.equal(authConfigured(), true);
  assert.equal(verifyPassword("a-long-enough-password"), true);
  assert.equal(verifyPassword("a-long-enough-passwore"), false, "one character off is still wrong");
  assert.equal(verifyPassword(""), false);
});

test("the plain password is never stored as itself", () => {
  clearAuthEnv();
  process.env.APP_PASSWORD = "a-long-enough-password";
  // What verification compares against is a scrypt hash, not the password.
  const salt = generateSalt();
  assert.notEqual(hashPassword("a-long-enough-password", salt), "a-long-enough-password");
  assert.equal(hashPassword("a-long-enough-password", salt).length, 128);
});

test("sessions signed under one password are worthless under another", () => {
  clearAuthEnv();
  process.env.APP_PASSWORD = "first-password-here";
  const token = createSessionToken();
  assert.equal(verifySessionToken(token), true);

  // Changing the password changes the derived signing secret, so every device
  // signed in under the old one is signed out.
  process.env.APP_PASSWORD = "second-password-here";
  assert.equal(verifySessionToken(token), false);
});

test("an explicit SESSION_SECRET survives a password change", () => {
  clearAuthEnv();
  process.env.APP_PASSWORD = "first-password-here";
  process.env.SESSION_SECRET = "explicitly-configured-secret";
  const token = createSessionToken();

  process.env.APP_PASSWORD = "second-password-here";
  assert.equal(verifySessionToken(token), true, "the secret was configured, not derived");
});

test("a tampered or expired session is rejected", () => {
  clearAuthEnv();
  process.env.APP_PASSWORD = "a-long-enough-password";

  const token = createSessionToken();
  const [expires, signature] = token.split(".");

  assert.equal(verifySessionToken(`${Number(expires) + 60_000}.${signature}`), false, "extending the expiry breaks the signature");
  assert.equal(verifySessionToken(`${expires}.${"0".repeat(signature.length)}`), false);
  assert.equal(verifySessionToken(`${Date.now() - 1000}.${signature}`), false, "an expired token is refused");
  assert.equal(verifySessionToken(undefined), false);
  assert.equal(verifySessionToken("nonsense"), false);
});

test("the hashed form wins when both are configured", () => {
  clearAuthEnv();
  const salt = generateSalt();
  process.env.APP_PASSWORD_SALT = salt;
  process.env.APP_PASSWORD_HASH = hashPassword("the-hashed-password", salt);
  process.env.SESSION_SECRET = "a-secret-value";
  process.env.APP_PASSWORD = "a-different-plain-password";

  assert.equal(verifyPassword("the-hashed-password"), true);
  assert.equal(verifyPassword("a-different-plain-password"), false);
});
