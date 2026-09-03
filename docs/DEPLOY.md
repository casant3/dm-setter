# Putting it online

The whole point of the mobile build is using this from the phone the Instagram
accounts are logged in on. That needs the app on the public internet over HTTPS,
which also happens to be what the PWA install and the clipboard API require.

Nothing here needs a terminal. Everything is done in a browser.

## 1. Deploy from GitHub

Any Node host works. Vercel is the path of least resistance for a Next.js app
and its free tier is enough for one operator.

1. Go to [vercel.com/new](https://vercel.com/new) and sign in **with GitHub**.
2. Import `casant3/dm-setter`.
3. Framework preset: **Next.js**. Build command, output directory and install
   command are all detected — change nothing.
4. Before clicking Deploy, open **Environment Variables** and add the four below.
5. Deploy.

The first build takes a couple of minutes. You get a URL like
`dm-setter.vercel.app`.

## 2. The environment variables

| Name | Value | Where it comes from |
| --- | --- | --- |
| `SUPABASE_URL` | `https://lpdaqrqudluccwymofzq.supabase.co` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ…` | Supabase → Settings → API → **service_role** (the secret one, not `anon`) |
| `OPENAI_API_KEY` | `sk-…` | platform.openai.com → API keys |
| `APP_PASSWORD` | a long password you choose | You. This is the only thing between the internet and your prospect conversations — use a password manager, 20+ characters |

That is the complete list. Everything else has a working default.

Set all four for **Production, Preview and Development** — Vercel asks per
environment, and a preview deployment without them will simply refuse to serve.

### About `APP_PASSWORD`

The app also accepts a pre-computed hash (`APP_PASSWORD_HASH`,
`APP_PASSWORD_SALT`, `SESSION_SECRET`), which keeps the password itself out of
the environment. That is the better form if you have a machine with Node on it:
run `npm run auth:setup` and use the three values it prints instead.

`APP_PASSWORD` exists because producing that hash needs a terminal, and this app
is meant to be deployable from a phone. The password then lives in the same
encrypted environment as the Supabase service-role key, which is a far more
dangerous secret, so it is not the weak link. Changing it signs every device out.

### What is deliberately not configurable

There is no Instagram login, token or credential anywhere in this app, and
nothing is ever sent automatically. Outbound accounts are attribution only. If
some future guide asks you to paste an Instagram password into an environment
variable, it is not this one.

## 3. Sign in and set up

1. Open the URL. You get the login screen.
2. Sign in with `APP_PASSWORD`.
3. Open **Accounts** (top bar on desktop, the account tab row on a phone) and add
   the Instagram pages you send from.
4. Add your first prospect. The account picker now has your pages in it.

If the top bar says *Local store* rather than *Supabase*, the Supabase variables
did not take — check them and redeploy.

## 4. Install it on the phone

Chrome on Android:

1. Open the URL.
2. Either tap **Install** on the banner the app shows, or use ⋮ → **Add to Home
   screen**.
3. Launch it from the home screen. No browser chrome, and the session lasts 30
   days with sliding renewal, so you are not signing in every day.

Safari on iOS: Share → **Add to Home Screen**. The manifest supports it, but the
build was tested against Android, which is what you use.

## 5. Keeping it private

- The app is closed by default: every data route requires the session cookie.
  There is no public page except the login screen.
- `robots` is set to `noindex, nofollow`, so it stays out of search results.
- The service worker caches build assets only — never an API response, never a
  page. Nothing about a prospect is stored offline on the device.
- Vercel deployment URLs are public addresses. They are unguessable in practice,
  but the password is what actually protects the app, not the URL.

## Rotating a leaked key

- **Supabase service-role key** — Supabase → Settings → API → *Reset*. Update the
  variable in Vercel and redeploy.
- **OpenAI key** — revoke at platform.openai.com, create a new one, update, redeploy.
- **`APP_PASSWORD`** — change the variable and redeploy. Every signed-in device is
  signed out immediately, because the session signing key is derived from it.

## Costs

- Vercel Hobby: free, and this workload sits well inside it.
- Supabase free tier: fine for a single operator; the database is small.
- OpenAI: pay per use. Each suggestion is three model calls (strategy, writer,
  reviewer) plus an occasional memory extraction.
