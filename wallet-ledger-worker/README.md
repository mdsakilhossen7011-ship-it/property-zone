# Property Zone Wallet Ledger Worker — read-only foundation

**Not deployed. Not connected to the customer/admin UI. No balance writes are implemented.**

This first Worker stage provides:
- Firebase ID-token signature and claim verification.
- Server-side service-account OAuth token exchange.
- Read-only Firestore lookup of `walletLedgers/{uid}`.
- Staged `POST /v1/package-purchase` endpoint: atomically debits Deposit Balance, credits Package Balance, creates the active package, and records an idempotency entry in one Firestore transaction.
- A summary endpoint that refuses accounts without an explicitly migrated ledger (`MIGRATION_PENDING`).
- Strict no-store responses and origin allowlisting.

## Configure locally / in Cloudflare
1. Create a dedicated Firebase service account with the minimum Firestore read permission needed for this read-only stage.
2. Store its entire JSON key as the Cloudflare Worker secret named `FIREBASE_SERVICE_ACCOUNT`. Never commit it or send it in chat.
3. Confirm `FIREBASE_PROJECT_ID` matches the Firebase project. The checked-in wrangler file contains the known project ID, but verify it in Firebase before deploying.
4. Set `ALLOWED_ORIGINS` to the exact deployed site origin(s), comma-separated.
5. Deploy only to a staging Worker first. Do not put the Worker URL into the production website yet.

## Endpoints
- `GET /health`: non-sensitive health response.
- `GET /v1/wallet-summary`: requires `Authorization: Bearer <Firebase ID token>`; returns only the authenticated user's server-owned ledger summary. It returns HTTP 409 `MIGRATION_PENDING` if no ledger exists.
- `POST /v1/package-purchase`: requires the same bearer token and JSON `{\"propertyId\":\"...\",\"propertyTitle\":\"...\",\"amountBDT\":1000,\"idempotencyKey\":\"unique-client-request-id\"}`. It only operates on an existing migrated ledger; it refuses missing/unmigrated ledgers and insufficient Deposit Balance. It writes the package and immutable purchase entry atomically.

## Deliberately not implemented
No deposit approval, profit accrual, withdrawal request, withdrawal approval/rejection, or migration writes. The package-purchase endpoint is staged only and cannot serve existing customers until each customer's Deposit/Package ledger has been safely reconciled and migrated. No changes to Firestore Rules. The existing combined-wallet flow remains the production path until all source-specific operations are implemented, tested, and deliberately switched over.

## Safety
- Never grant broad project-owner/editor access to this service account.
- Keep service account JSON out of GitHub, browser code, issue comments, and chat.
- The Worker has no write endpoints in this stage. Do not expand its IAM permissions until write operations are implemented and reviewed.
- The endpoint does not derive or migrate legacy balances. An absent ledger is a hard stop.
