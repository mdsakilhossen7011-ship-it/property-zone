const admin = require("firebase-admin");

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const sum = (items, pick) => money(items.reduce((total, item) => total + Number(pick(item) || 0), 0));

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT secret.");
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  // READ ONLY: this script deliberately performs no writes and changes no balances.
  const [walletSnap, enquirySnap, packageSnap, earningSnap] = await Promise.all([
    db.collection("wallets").get(),
    db.collection("propertyEnquiries").get(),
    db.collection("activePackages").get(),
    db.collection("earningLedger").get()
  ]);

  const byUid = new Map();
  const get = (uid) => {
    if (!byUid.has(uid)) byUid.set(uid, {
      uid, walletBalanceBDT: 0, pendingWithdrawalBDT: 0,
      approvedDepositsBDT: 0, approvedWithdrawalsBDT: 0,
      pendingWithdrawalsBDT: 0, packagePurchasesBDT: 0,
      activePackagePrincipalBDT: 0, completedPackagePrincipalBDT: 0,
      creditedEarningsBDT: 0, returnedPrincipalBDT: 0,
      ledgerRecordedWalletCreditsBDT: 0, legacyUnclassifiedDeltaBDT: 0,
      issues: []
    });
    return byUid.get(uid);
  };

  for (const doc of walletSnap.docs) {
    const w = doc.data(), row = get(doc.id);
    row.walletBalanceBDT = money(w.balanceBDT ?? (Number(w.balanceUSD || 0) * Number(w.exchangeRateBDT || 0)));
    row.pendingWithdrawalBDT = money(w.pendingWithdrawalBDT || 0);
  }

  for (const doc of enquirySnap.docs) {
    const r = doc.data();
    if (!r.uid || !Number.isFinite(Number(r.amountBDT))) continue;
    const row = get(r.uid), amount = money(r.amountBDT);
    if (r.requestType === "wallet-deposit" && ["approved", "success"].includes(String(r.status || "").toLowerCase())) {
      row.approvedDepositsBDT = money(row.approvedDepositsBDT + amount);
    }
    if (r.requestType === "wallet-withdraw") {
      if (["approved", "success"].includes(String(r.status || "").toLowerCase())) {
        row.approvedWithdrawalsBDT = money(row.approvedWithdrawalsBDT + amount);
      } else if (["pending", "open"].includes(String(r.status || "").toLowerCase())) {
        row.pendingWithdrawalsBDT = money(row.pendingWithdrawalsBDT + amount);
      }
    }
  }

  for (const doc of packageSnap.docs) {
    const p = doc.data();
    if (!p.uid) continue;
    const row = get(p.uid), amount = money(p.amountBDT ?? (Number(p.amountUSD || 0) * Number(p.exchangeRateBDT || 0)));
    row.packagePurchasesBDT = money(row.packagePurchasesBDT + amount);
    if (p.status === "active") row.activePackagePrincipalBDT = money(row.activePackagePrincipalBDT + amount);
    else if (["completed", "matured"].includes(String(p.status || "").toLowerCase())) {
      row.completedPackagePrincipalBDT = money(row.completedPackagePrincipalBDT + amount);
    } else {
      row.issues.push("Package " + doc.id + " has nonstandard status: " + String(p.status || "missing"));
    }
  }

  for (const doc of earningSnap.docs) {
    const e = doc.data();
    if (!e.uid) continue;
    const row = get(e.uid);
    row.creditedEarningsBDT = money(row.creditedEarningsBDT + Number(e.earningsBDT || 0));
    row.returnedPrincipalBDT = money(row.returnedPrincipalBDT + Number(e.principalReturnedBDT || 0));
    row.ledgerRecordedWalletCreditsBDT = money(row.ledgerRecordedWalletCreditsBDT + Number(e.totalWalletCreditBDT || 0));
  }

  const rows = [...byUid.values()].map((r) => {
    const expectedWalletBeforeUnrecordedAdjustments = money(
      r.approvedDepositsBDT - r.packagePurchasesBDT - r.approvedWithdrawalsBDT
      + r.ledgerRecordedWalletCreditsBDT
    );
    // A positive or negative delta means the history is incomplete or has manual/legacy changes.
    r.legacyUnclassifiedDeltaBDT = money(r.walletBalanceBDT - expectedWalletBeforeUnrecordedAdjustments);
    r.withdrawalReserveDeltaBDT = money(r.pendingWithdrawalBDT - r.pendingWithdrawalsBDT);
    r.migrationStatus = (Math.abs(r.legacyUnclassifiedDeltaBDT) < 0.02
      && Math.abs(r.withdrawalReserveDeltaBDT) < 0.02
      && r.issues.length === 0) ? "RECONCILED_REVIEW_REQUIRED" : "MANUAL_REVIEW_REQUIRED";
    return r;
  }).sort((a, b) => a.uid.localeCompare(b.uid));

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READ_ONLY_NO_WRITES",
    totals: {
      wallets: walletSnap.size, enquiries: enquirySnap.size,
      packages: packageSnap.size, earningLedgerEntries: earningSnap.size,
      reconciledReviewRequired: rows.filter(r => r.migrationStatus === "RECONCILED_REVIEW_REQUIRED").length,
      manualReviewRequired: rows.filter(r => r.migrationStatus === "MANUAL_REVIEW_REQUIRED").length
    },
    customers: rows
  };

  const fs = require("fs");
  const path = process.env.AUDIT_OUTPUT || "wallet-ledger-migration-audit.json";
  fs.writeFileSync(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report.totals, output: path, mode: report.mode }, null, 2));
  await admin.app().delete();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
