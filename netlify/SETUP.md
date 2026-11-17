# Property Zone — Netlify OTP + dual login setup

Deploy the `netlify-otp` branch to Netlify. The current GitHub Pages main branch has intentionally been kept unchanged until the new deployment is tested.

## Deploy
1. In Netlify choose **Add new project → Import an existing project → GitHub**.
2. Select `mdsakilhossen7011-ship-it/property-zone`.
3. Set the production branch to `netlify-otp` and deploy. Root `netlify.toml` configures the existing site and functions.

## Environment variables
In Netlify Project configuration → Environment variables, add these values, then redeploy:
- `ONE9_API_KEY`: a newly generated One9 API key. Never commit it to GitHub or send it in chat.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete Firebase service-account JSON for project `property-zone-17121`, stored only as a secret.
- `FIREBASE_WEB_API_KEY`: the Firebase Web API key used by the website.
- `PZ_ALLOWED_ORIGINS`: exact comma-separated origins allowed to call the functions (the Netlify site origin, plus the production custom domain when configured).

## Functions
- `otp-send`: sends a 6-digit One9 OTP; applies a 60-second cooldown and five-per-day limit.
- `otp-verify`: verifies through One9 and creates a short-lived, one-use verification token in Firestore.
- `complete-registration`: validates the signed-in Firebase user and verified OTP, then attaches the phone number to Firebase Auth.
- `phone-login`: checks the phone/password with Firebase and returns a Firebase custom token without exposing the account email.

Email + password login remains available. Phone + password login is available for accounts with a verified phone number attached. Existing accounts without a verified phone continue using email login until their phone is verified and linked.

## Production checks
No SMS has been sent as part of preparing these files. Before moving the public domain from GitHub Pages to Netlify, test OTP delivery, expiry, wrong-code attempts, duplicate-phone rejection, email login, and phone login. Do not enable public signup until the secrets and deployment are configured.
