# Property Zone Wallet Ledger Worker — segregated wallet backend (staged)

**Not deployed. Do not configure the production site to use this Worker until staging tests and the reviewed migration are complete.** All money-moving endpoints require a migrated walletLedgers/{uid} document. There is no legacy-wallet fallback.

## Implemented server endpoints

- GET /health: health response.
- GET /v1/wallet-summary: authenticated member's Deposit, Package and Profit balances, with pending withdrawal reserves subtracted from withdrawable amounts.
- POST /v1/package-purchase: atomic Deposit debit + Package principal credit + active package + idempotency record.
- POST /v1/withdrawal-request: reserves the chosen Deposit, Package or Profit source balance and creates a pending request atomically. Package withdrawals require the exact full amount of one active package and mark that package withdrawal_pending.
- POST /v1/admin/wallet-decision: admin-only deposit approval/rejection and withdrawal approval/rejection. Deposit approval credits Deposit Balance; withdrawal approval debits the selected source and releases its reserve; rejection only releases the reserve. Package approval closes the package; rejection restores it to active.
- POST /v1/admin/profit-accrual: admin-only single-package accrual. It credits whole 24-hour periods, capped at the package term; at maturity it moves principal from Package Balance back to Deposit Balance and marks the package completed.
- POST /v1/admin/migrate-member: admin-only, explicit reviewed migration. It requires the operator to classify legacy wallet funds into Deposit and Profit so their sum exactly equals the legacy combined wallet. Package Balance must exactly equal the sum of that member's active package principals. Existing ledgers, pending legacy withdrawals, mismatched totals, and unresolved amounts are hard stops.

The Worker has an hourly Cloudflare Cron trigger. It scans active packages and runs the same idempotent 24-hour accrual logic; package creditedDays and transaction entries prevent duplicate credits.

## Migration rules

1. Run node scripts/audit-wallet-ledger-migration.js first and review its output securely.
2. Do not guess a customer's Deposit/Profit split. Use verified deposit, withdrawal, earning, maturity and admin records. If the split is unclear, leave the customer unmigrated.
3. The migration endpoint accepts { uid, depositBDT, packageBDT, profitBDT }. Deposit + Profit must equal the exact legacy wallet balance in poisha. Package must equal the sum of active packages read from Firestore.
4. Existing legacy pending withdrawals block migration. Reconcile those requests separately; never silently release or double-reserve them.
5. Migration creates a ledger and a migration audit document atomically. It does not change or delete the legacy wallet or package records.

## Required Cloudflare configuration

- Secret FIREBASE_SERVICE_ACCOUNT: service-account JSON stored directly in Cloudflare, never committed or sent in chat.
- Variable FIREBASE_PROJECT_ID=property-zone-17121.
- ALLOWED_ORIGINS must contain exact deployed website origins.
- Service account requires Firestore read/write access for the collections used by this Worker. Keep credentials private and restrict access.
- Set siteSettings/wallet.walletLedgerApiUrl only after a staging Worker passes tests and review.

## Important limitations before production

- Admin decision requires admins/{uid} with role=admin and active=true.
- Admin must verify the actual deposit proof before approving and must send withdrawal payout before approving.
- Existing legacy withdrawals that lack a ledger source and server-side reserve are blocked for manual reconciliation.
- The migration split is intentionally explicit and manual. No combined balance is automatically guessed into Deposit or Profit.
- Firestore Rules have not been changed.
- No production deployment or live Firestore migration has been performed.
