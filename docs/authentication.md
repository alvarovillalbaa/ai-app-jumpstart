# Accounts and API credentials

Authentication and record storage are independent. Keep `AUTH_PROVIDER=api-key` for administrator-issued credentials, or select `supabase` for browser accounts. Supabase identity can own records in any supported data provider. Configured API keys continue to work alongside Supabase users.

## Configure Supabase sign-in

```dotenv
AUTH_PROVIDER=supabase
SUPABASE_AUTH_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_PUBLIC_KEY
APP_ORIGIN=https://YOUR-APPLICATION.example
```

`SUPABASE_AUTH_URL` defaults to `SUPABASE_URL` when omitted. Use a publishable key or legacy `anon` key. Secret keys and legacy service-role keys are rejected before settings can be rendered into a page. Public settings are passed from the server at request time, so the same Docker image can be configured for different organizations without rebuilding it with `NEXT_PUBLIC_*` values.

In Supabase, enable email/password sign-in and email confirmation, set the minimum password length to at least 12, and configure production SMTP. Set Site URL to `APP_ORIGIN`. Allow the exact application's `/auth/callback` redirect, including the `/account` and `/account/password` `next` query values used by the forms. Keep preview and production projects and allowlists separate; do not allow arbitrary deployment domains in production.

The shipped routes are `/login`, `/signup`, `/recover`, `/account`, and `/account/password`. The account screen uses the same records API as CLI and MCP. `/records` remains the administrator-issued credential console. OAuth buttons are not exposed until a provider is configured and implemented.

## Email confirmation and recovery

The default Supabase email links work with the PKCE code exchange at `/auth/callback`. Open these links in the browser that started signup or recovery, because the code verifier is stored there. Invalid, expired and cross-browser exchanges return a sign-in error instead of an authenticated-looking screen.

For confirmation across browsers, customize email templates to use the application confirmation page:

```html
<!-- Confirm signup -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/account">Confirm email</a>
<!-- Recover password -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">Reset password</a>
```

The GET page does not consume the one-time token. The user's Continue action posts to `/auth/verify`, which checks the application origin, verifies the token, propagates the resulting cookies and returns an allowlisted destination. Recovery always goes to `/account/password`. Auth pages send `Referrer-Policy: no-referrer`; application logs omit URLs, credentials and request bodies.

New free-tier Supabase projects using default SMTP may not customize email templates; use custom SMTP when enabling those links. See [Supabase's email-template change](https://supabase.com/changelog/46599-changes-to-email-template-customisation-on-free-tier).

## Identity and isolation

The request-scoped SSR client uses `getUser()`; it does not authorize from the cookie's `getSession()` user object. Proxy refreshes propagate both request and response cookie chunks and the SSR library's cache headers. Account HTML and auth responses stay private and uncached. Handlers independently verify every bearer token with `getUser()` before accessing records. Missing or expired credentials return 401; identity-service outages return 503.

The server derives ownership from the configured identity-provider origin and verified user ID. It ignores `user_metadata`, and rejects anonymous accounts. This is a single-organization account model: team membership, roles and entitlements require additional authoritative policy. Changing the identity-provider origin changes the owner namespace and requires a planned data migration.

Browser session events clear the old account's records and draft form by remounting that screen on account changes. A late token lookup cannot issue an API request for a newly selected account. Sign-out revokes the current session, clears the browser session and refreshes server navigation. API and MCP require explicit bearer credentials; they do not authorize using ambient cookies.

CLI and MCP can use a current Supabase access token or an administrator-issued API key. Supabase access tokens expire; those clients currently require the caller to supply a refreshed token. Do not put a database key or Supabase service credential into `APP_API_TOKEN`.

Upload quarantine uses separate `uploads:read` and `uploads:write` API-key scopes. Generate them with `npm run auth:key -- TENANT SUBJECT uploads-read` or `uploads-write`; `all-read` and `all-write` include record scopes too. Registered Supabase users receive both upload scopes. The upload API stores bytes privately but does not offer a download or attachment path until scanning and release policy are implemented; see [uploads](uploads.md).

## Account chat

Signing in enables private records. Account chat remains disabled until the operator configures the shared ownership store, signed creation broker, runtime origin and reviewed budget policy, then sets `AI_CHAT_ENABLED=true` on both services. The enabled Eve channel verifies owner identity and signed creation; it does not use the local development authenticator. See [account chat](account-chat.md) and [agent session access](agent-session-access.md). Supabase RLS does not authorize an Eve stream.

## Validate

Run `npm run check` for identity, metadata rejection, redirect, cookie propagation, form and existing data contracts. For a real browser flow, build with `npm run build:local`, install Chromium, and run `npm run test:auth` with Docker available. The harness provisions disposable PostgreSQL, pinned Supabase Auth and Mailpit containers and a local gateway; it sends email only to the local inbox. It starts the compiled Next service for account tests and does not open local Eve workflow storage. No hosted project or live SMTP credentials are used. Auth traces and screenshots are disabled; failure diagnostics can still contain disposable fixture account values, so do not target real accounts.

Local service evidence does not validate a hosted project's redirect allowlist, SMTP deliverability, account policies or production secrets. Rehearse the same flow in each deployed environment.
