# Account preferences

Theme and optional sound feedback share a versioned owner-scoped contract across SQLite, PostgreSQL, Supabase and Convex. They work independently of account chat. Registered accounts use saved server values after an authenticated read; signed-out users use a separate device preference. Login and hydration never write device defaults into an account. Logout restores the signed-out device choice.

An account without a saved row reads `{schemaVersion:1,revision:0,updatedAt:null,theme:"system",soundEnabled:false,soundVolume:0.5}` without creating a row. Themes are `system`, `light` or `dark`; volume is between zero and one. The first explicit write creates revision one. Later writes require the last read revision and increment it atomically. A stale or concurrent write returns HTTP 409 without changing saved fields. Refresh, review the current values and submit the intended change again. Fields omitted from a patch retain their saved values; explicit `false`, `0` and `system` are valid resets.

## Surfaces

The workspace theme selector saves explicit choices. Account settings provide an enable-sounds checkbox, volume draft with a separate Save volume button, Test sound and Refresh preferences. Controls wait for the authenticated read and save response. Failed saves retain the previous confirmed values and show a retry message. Focus refreshes account preferences unless a write is pending; another device's changes are otherwise read on reload or explicit refresh. There is no realtime subscription.

Use a current registered-user bearer token for these operations:

| Surface | Read | Update |
| --- | --- | --- |
| REST | `GET /api/v1/account/preferences` | `PATCH /api/v1/account/preferences` with `{revision,theme?,soundEnabled?,soundVolume?}` |
| CLI | `npm run app -- account preferences` | `npm run app -- account preferences update PATCH.json` |
| MCP | `account_preferences` or `account:///preferences` | `account_preferences_update` with the same patch |

Configure CLI credentials through `APP_API_URL` and `APP_API_TOKEN`. Keep tokens out of arguments and version control. Patches require at least one editable field and fit within 4 KiB. Unknown fields, invalid values and owner injection fail validation. Record API keys cannot read or edit account preferences, even when their configured owner matches the account. Identity is verified for each request and both tenant and subject scope storage access.

## Sound policy

Cuelume supplies the existing audio engine. Sounds start muted until an explicit saved choice is loaded; loading or enabling that choice does not play anything. Test sound is explicit. A successful user-initiated record creation may play one success cue, paired with the visible record; record loads, refreshes, navigation, token streaming, historical replay and background reconnect do not play cues. The initiating action captures permission and account identity. Account changes, unmounting, disconnecting, disabled sound and hidden documents suppress a delayed record cue. Browser audio restrictions leave the data action successful. Volume zero remains valid. Reduced motion is independent of sound preference.

Device settings use `jumpstart-device-preferences-v1`. Existing `jumpstart-theme` supplies a theme only when the new device key is absent. The first account activation snapshots the independent device value before next-themes can change its legacy rendering cache. Account values never replace this separate device entry. Audio objects are not persisted. An unavailable account read leaves controls unavailable with a refresh action; it does not substitute a writable device default for the saved account choice.

## Storage and upgrades

SQLite initializes `app_user_preferences` on first access in the application database. PostgreSQL and Supabase require `20260927160000_user_preferences.sql` through `npm run db:migrate`; the migration creates a private RLS table and backend-only RPC. Direct anonymous/authenticated table and RPC access is denied. The backend derives owners from verified identities rather than browser input. Convex requires the updated schema and internal preference functions; the existing secret-protected backend dispatcher invokes them, and public clients cannot call the internal functions. Supabase types and Convex definitions were generated against their actual schemas.

Application-visible exports now use `ai-app-jumpstart-visible-data-v7` and include one `account_preferences` line after the profile, plus the `preferences` footer count. Reading an unsaved account exports its defaults without reserving a revision. The verifier also accepts digest-bearing v5 and v6 artifacts with their original sections/counts. Record-only exports have a preferences count of zero. Export reads are live, not a transaction snapshot; existing [export exclusions](data-access.md#export-visible-application-data) remain.

## Verification

Shared adapter tests cover defaults, sparse writes, both owner fields, concurrent first writes, stale revisions and validation. Frontend tests cover server-first hydration without writes or autoplay, fresh credentials, conflicts, delayed account responses, signed-out device restoration and confirmed-action cue suppression. The real Auth/browser suite checks two devices and two accounts, CLI/MCP parity, explicit volume commit, zero audio contexts on reload, stale-write denial and automated accessibility. Hosted acceptance and manual assistive-technology review remain separate release work.
