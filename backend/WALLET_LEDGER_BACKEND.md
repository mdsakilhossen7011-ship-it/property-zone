# Property Zone — Firebase-only wallet flow

This implementation uses the existing Firebase project, existing Firestore Security Rules, the current customer site, the separate Wallet Admin Panel, and the existing scheduled GitHub Actions earnings job.

## No additional paid infrastructure

- No Cloudflare account or Worker.
- No Firebase Cloud Functions.
- No Firebase Billing upgrade.
- No Firestore Security Rules change.
- Daily profit accrual continues through the existing GitHub Actions workflow and its existing `FIREBASE_SERVICE_ACCOUNT` repository secret.

## Four wallet operations

1. **Deposit:** the member creates a pending deposit request. Admin verifies the payment and approves it. Approval credits `wallets/{uid}.depositBalanceBDT` (Deposit Balance) exactly once in a Firestore transaction.
2. **Package purchase:** the existing Firestore transaction debits Deposit Balance and creates an `activePackages/{packageId}` record. Package Balance is calculated from the member's active package principals; it is not added to Deposit Balance.
3. **Profit:** the scheduled `scripts/credit-daily-earnings.js` job credits matured 24-hour earnings to `profitBalanceBDT`. At package maturity, principal returns to `depositBalanceBDT` and earnings go to `profitBalanceBDT`. Package status and earning-ledger records make processing idempotent.
4. **Withdrawal:** the member selects Deposit, Package, or Profit. The request is reserved in the existing `pendingWithdrawalBDT` field and records its source in the already-permitted `message` field using `[PZ_SOURCE=deposit]`, `[PZ_SOURCE=profit]`, or `[PZ_SOURCE=package;PACKAGE_ID=...]`. Admin approval debits only that source. Package withdrawal must match the full selected active package and closes that package. Rejection releases the reserve.

## Legacy records

Older wallet balances may contain a mixture of deposits, earnings, and returned package principal. The app does not guess a historic split. Older withdrawal requests without a source marker require manual review before approval. If an old pending withdrawal reserve cannot be reconciled with source-tagged requests, new withdrawal requests are paused until Admin resolves it.

## Validation

The Firebase Wallet Checks workflow verifies the customer site's inline JavaScript and the daily earnings script syntax. The Admin Wallet Frontend Checks workflow verifies the separate wallet admin page.

No live balance migration is performed by this change. Legacy combined `balanceBDT` / `balanceUSD` values are left untouched and are not counted as Deposit Balance. New approved deposits and returned package principal use `depositBalanceBDT`. Existing wallet documents and package records are preserved.
