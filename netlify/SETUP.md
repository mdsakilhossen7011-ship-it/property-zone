# Property Zone — Netlify OTP + dual login setup

The Netlify Functions are prepared in `netlify/functions/`. They are **not live** until the repository is deployed to Netlify and the required environment variables are saved there.

## Deploy the repository

1. In Netlify, choose **Add new project → Import an existing project → GitHub**.
2. Select `mdsakilhossen7011-ship-it/property-zone` and deploy. The root `netlify.toml` publishes the existing site and the `netlify/functions` directory.
3. Keep the GitHub Pages site untouched until the Netlify deployment has been checked. The frontend uses relative `/.netlify/functions/...` paths, so OTP and phone login work when the site itself is served by Netlify.

## Netlify environment variables

Set these in **Project configuration → Environment variables**, then trigger a fresh deploy:

- `ONE9_API_KEY` — a newly generated One9 API key. Never commit this value to GitHub.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — the complete Firebase service-account JSON for project `property-zone-17121`. Store it only as a Netlify secret.
- `FIREBASE_WEB_API_KEY` — the Firebase Web API key already used by the website.
- `PZ_ALLOWED_ORIGINS` — comma-separated exact origins allowed to call the functions, e.g. the Netlify site origin and, after domain setup, the production custom-domain origin.

## What the functions do

- `otp-send`: checks phone format and existing Firebase phone accounts, applies a resend cooldown/daily cap, then requests a six-digit OTP from One9.
- `otp-verify`: verifies the OTP through One9 and creates a short-lived one-use verification token in Firestore.
- `complete-registration`: verifies the signed-in Firebase user and one-use OTP token, then attaches the verified phone number to the Firebase Auth account.
- `phone-login`: resolves the Firebase account by verified phone number, validates the password with Firebase Identity Toolkit, then returns a Firebase custom token. The email address is not returned to the browser.

Email + password login remains supported. Phone + password login uses the same Firebase password. Password reset remains email-only.

## Important before production

- Do not paste service-account JSON or One9 API keys into chat, HTML, JavaScript, or GitHub.
- No live SMS has been sent as part of this code change.
- Before switching the public domain from GitHub Pages to Netlify, verify deployment, CORS origins, One9 API response compatibility, OTP delivery, OTP expiry, duplicate-phone rejection, email login, and phone login.
- The backend depends on Firebase Admin credentials stored as Netlify secrets. Do not enable public registration until those secrets and deployment are configured.
