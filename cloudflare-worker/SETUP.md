# Property Zone — Signup Phone OTP Worker

This Worker is used only before a new account is created. Login and every other website feature remain unchanged.

## Cloudflare setup

1. Create a Cloudflare account and open Workers & Pages.
2. Create a KV namespace named PROPERTY_ZONE_OTP.
3. In wrangler.toml, replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID with that namespace ID.
4. Deploy this Worker using Wrangler, or create a Worker in the dashboard and paste index.js.
5. Bind the KV namespace with variable name OTP_STORE.
6. Add Worker settings:
   - Secret: BULKSMSBD_API_KEY = your BulkSMSBD API key
   - Variable: BULKSMSBD_SENDER_ID = your approved sender ID
7. Deploy the Worker and copy its workers.dev URL.

## Website connection

The signup code contains a safe placeholder: https://YOUR-CLOUDFLARE-WORKER.workers.dev
After the Worker is deployed, replace it in index.html with your actual Worker URL. Never put the SMS API key in index.html or GitHub.

## OTP protections

- Bangladesh mobile numbers only (+880)
- Six-digit OTP, five-minute expiry
- 60-second resend cooldown
- Maximum five OTP sends per phone per day
- Maximum five incorrect verification attempts
- Verified phone is marked used after successful account creation

The service is not live until the KV binding, BulkSMSBD credentials, Worker URL, and a real SMS delivery test are completed.
