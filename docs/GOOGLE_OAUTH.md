# Google OAuth

Jarvis uses one shared Google credential path for Gmail and Calendar.

Required scopes:

- `https://mail.google.com/`
- `https://www.googleapis.com/auth/calendar`

Preferred setup:

1. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `OAUTH_REDIRECT_URI`.
2. Call `GET /v1/oauth/google/authorize` with `X-API-Key`, or temporarily set `OAUTH_SETUP_ENABLED=true`.
3. Complete Google consent.
4. The callback stores the refresh token in `OAUTH_REFRESH_TOKEN_STORE_PATH` under the shared key `google:primary:<clientId>`.

`GOOGLE_REFRESH_TOKEN` remains supported as a compatibility fallback when the persistent store has no token.

Never log or commit OAuth codes, client secrets, access tokens, or refresh tokens.
