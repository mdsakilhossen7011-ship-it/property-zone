# Property Zone wallet ledger backend

Status: preparation only. This backend is NOT deployed and must not be connected to the live customer UI until the migration and integration checks below pass.

## Non-negotiable constraints
- Do not change Firestore Security Rules.
- Do not overwrite or delete existing wallets, deposit requests, activePackages, or withdrawal requests.
- Keep the current single-wallet flow untouched until the backend is deployed and verified.
- Never infer a customer's historic deposit/package/profit split from the current wallet balance alone.

## Intended ledger
A server-owned document per customer (for example `walletLedgers/{uid}`) with integer poisha fields:
- `depositAvailablePoisha`: approved deposit funds not yet used for package purchases or withdrawals.
- `packagePrincipalPoisha`: principal currently held in active packages and eligible for package-principal withdrawal under the agreed policy.
- `profitAvailablePoisha`: matured profit only (profit becomes withdrawable after 24 hours).
- `pendingDepositWithdrawalPoisha`, `pendingPackageWithdrawalPoisha`, `pendingProfitWithdrawalPoisha`: reserved requests by source.
- `schemaVersion`, `updatedAt`.

All balance mutations must be performed server-side in an atomic Firestore transaction and recorded in an immutable ledger entry with a unique idempotency key. Clients must never write ledger documents directly.

## Required server operations
1. Approve deposit: credit deposit balance exactly once for a pending `wallet-deposit` request.
2. Buy package: debit deposit balance and credit package principal in the same transaction as creating the active package.
3. Accrue profit: calculate from active package start/rate history; credit only completed 24-hour periods to available profit. A scheduled/triggered job must be idempotent.
4. Request withdrawal: reserve only the selected source balance.
5. Admin approve withdrawal: debit the selected reserved source exactly once.
6. Admin reject withdrawal: release the reservation to the same source.
7. Read balances: return a server-computed balance summary to the signed-in customer.

## Legacy migration gate
Before any customer is moved to the new ledger, reconcile that customer's:
- approved historical deposit requests,
- package purchase records / activePackages,
- completed and pending withdrawals,
- existing wallet balance and pendingWithdrawalBDT,
- any manually adjusted/admin credited amounts.

Do not auto-migrate a customer if the source history does not reconcile. Mark for manual review and keep the old wallet untouched. Existing wallet balance is not automatically classified as deposit, package, or profit.

## Deployment prerequisites
- A Cloudflare Worker deployment controlled by the site owner.
- A dedicated Firebase service account with the minimum required Firestore permissions, stored only as a Cloudflare Worker secret (never in HTML, GitHub source, or browser JavaScript).
- Worker environment variables for Firebase project ID and allowed admin UIDs.
- A verified Worker URL configured in the customer and admin apps only after deployment.
- Test Firebase project or isolated test users for end-to-end tests.

## Go-live checklist
- Verify Firebase ID tokens on every request (issuer, audience, expiry, signature).
- Authorize admin actions server-side using a fixed allowlist / verified claims; never trust a client-supplied admin flag.
- Use Firestore transactions and idempotency keys for every monetary mutation.
- Reject negative, fractional-poisha, duplicate, stale, or inconsistent requests.
- Test concurrent package purchases, duplicate admin clicks, rejected withdrawals, 24-hour profit maturity, and retries.
- Compare ledger totals with the legacy records before enabling any customer.
- Do not change Firestore Rules as part of this work.

## Read-only migration audit utility
A read-only reconciliation script is included at `scripts/audit-wallet-ledger-migration.js`.
Run it in a trusted local environment with the Firebase service-account JSON supplied through the `FIREBASE_SERVICE_ACCOUNT` environment variable:

```bash
npm run audit:wallet-ledger
```

It reads wallets, deposit/withdrawal requests, package records, and earningLedger records; it writes only a local report file (default `wallet-ledger-migration-audit.json`). It does not write to Firestore. Treat the report as sensitive because it contains customer UIDs and financial totals; do not commit or publicly upload it. A customer marked `RECONCILED_REVIEW_REQUIRED` still requires a human review before migration. All other customers are marked for manual review. This audit is a first-pass reconciliation, not authorization to migrate funds.

## Worker implementation status (stage 1)
A separate Cloudflare Worker foundation now exists under `wallet-ledger-worker/`. It verifies Firebase ID-token signatures and claims, exchanges a server-held service-account key for a Firestore access token, and exposes a read-only `GET /v1/wallet-summary` endpoint for a previously migrated `walletLedgers/{uid}` document. Missing ledgers return `MIGRATION_PENDING`; the Worker does not infer balances from legacy wallet data.

This is deliberately read-only. It has no deposit approval, package purchase, profit accrual, withdrawal request, withdrawal approval/rejection, or migration-write endpoints. It is not deployed and is not connected to either website. The current production customer/admin flow remains unchanged. Deploy only to a staging Worker after setting secrets directly in Cloudflare; never commit or message the service-account JSON.
