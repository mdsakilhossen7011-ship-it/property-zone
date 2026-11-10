const admin = require("firebase-admin");

function roundBDT(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT secret.");

  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const packagesSnap = await db.collection("activePackages")
    .where("status", "==", "active")
    .get();

  let creditedPackages = 0;
  let creditedEarnings = 0;
  let returnedPrincipal = 0;
  let skipped = 0;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (const packageDoc of packagesSnap.docs) {
    try {
      const result = await db.runTransaction(async (tx) => {
        const packageRef = db.collection("activePackages").doc(packageDoc.id);
        const freshPackageSnap = await tx.get(packageRef);
        if (!freshPackageSnap.exists) return null;

        const p = freshPackageSnap.data();
        if (p.status !== "active") return null;

        const startedAtMs = p.startedAt && typeof p.startedAt.toMillis === "function"
          ? p.startedAt.toMillis()
          : NaN;
        if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {
          throw new Error("Package has no valid startedAt timestamp.");
        }

        const termDays = Math.max(1, Math.min(365, Number(p.termDays || 30)));
        const elapsedPackageDays = Math.max(0, Math.min(termDays, Math.floor((now - startedAtMs) / dayMs)));
        let scheduleStartMs = p.earningScheduleStartedAt && typeof p.earningScheduleStartedAt.toMillis === "function"
          ? p.earningScheduleStartedAt.toMillis()
          : null;
        let scheduleMaxDays = p.earningScheduleMaxDays == null ? null : Number(p.earningScheduleMaxDays);

        if (scheduleStartMs == null) {
          if (elapsedPackageDays >= termDays) {
            // Preserve the existing 30-day maturity payout for packages already matured before automation was enabled.
            scheduleStartMs = startedAtMs;
            scheduleMaxDays = termDays;
          } else {
            // Start future daily credits from activation of this scheduler; do not back-credit older estimates.
            scheduleStartMs = now;
            scheduleMaxDays = Math.max(0, termDays - elapsedPackageDays);
            tx.update(packageRef, {
              earningScheduleStartedAt: admin.firestore.Timestamp.fromMillis(now),
              earningScheduleMaxDays: scheduleMaxDays,
              creditedDays: 0,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return null;
          }
        }

        const effectiveScheduleStartMs = scheduleStartMs;
        const maxCreditDays = Math.max(0, Math.min(termDays, Number(
          scheduleMaxDays == null ? Math.max(0, termDays - elapsedPackageDays) : scheduleMaxDays
        )));
        const dueCreditDays = Math.max(0, Math.min(maxCreditDays, Math.floor((now - effectiveScheduleStartMs) / dayMs)));
        const alreadyCreditedDays = Math.max(0, Math.min(maxCreditDays, Number(p.creditedDays || 0)));
        const newDays = Math.max(0, dueCreditDays - alreadyCreditedDays);
        const matured = elapsedPackageDays >= termDays;

        if (newDays === 0 && !matured) return null;

        const settingsRef = db.collection("siteSettings").doc("wallet");
        const walletRef = db.collection("wallets").doc(String(p.uid || ""));
        if (!p.uid) throw new Error("Package has no uid.");

        const [settingsSnap, walletSnap] = await Promise.all([
          tx.get(settingsRef),
          tx.get(walletRef)
        ]);
        const settings = settingsSnap.exists ? settingsSnap.data() : {};
        const exchangeRate = Number(settings.exchangeRateBDT || 0);

        const principal = Number(
          p.amountBDT != null
            ? p.amountBDT
            : Number(p.amountUSD || 0) * Number(p.exchangeRateBDT || exchangeRate)
        );
        if (!Number.isFinite(principal) || principal <= 0) {
          throw new Error("Package principal is invalid.");
        }

        const dailyRate = Number(p.dailyRate == null ? 0.02 : p.dailyRate);
        if (!Number.isFinite(dailyRate) || dailyRate < 0 || dailyRate > 1) {
          throw new Error("Package dailyRate is invalid.");
        }

        let balance = 0;
        if (walletSnap.exists) {
          const wallet = walletSnap.data();
          if (Number.isFinite(Number(wallet.balanceBDT))) {
            balance = Number(wallet.balanceBDT);
          } else {
            const legacyUSD = Number(wallet.balanceUSD || 0);
            if (!Number.isFinite(legacyUSD) || legacyUSD < 0) {
              throw new Error("Member wallet balance is invalid.");
            }
            if (legacyUSD > 0 && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
              throw new Error("Missing BDT exchange rate for legacy wallet.");
            }
            balance = roundBDT(legacyUSD * exchangeRate);
          }
        }

        const earnings = roundBDT(principal * dailyRate * newDays);
        const principalReturn = matured ? roundBDT(principal) : 0;
        const totalCredit = roundBDT(earnings + principalReturn);
        const nextBalance = roundBDT(balance + totalCredit);
        const nextCreditedDays = Math.max(alreadyCreditedDays, dueCreditDays);

        if (walletSnap.exists) {
          tx.update(walletRef, {
            balanceBDT: nextBalance,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          tx.set(walletRef, {
            uid: p.uid,
            balanceBDT: nextBalance,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        const ledgerRef = db.collection("earningLedger").doc(
          packageDoc.id + "_through_day_" + nextCreditedDays
        );
        tx.set(ledgerRef, {
          uid: p.uid,
          packageId: packageDoc.id,
          principalBDT: roundBDT(principal),
          daysCredited: newDays,
          earningsBDT: earnings,
          principalReturnedBDT: principalReturn,
          totalWalletCreditBDT: totalCredit,
          creditedThroughDay: nextCreditedDays,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          source: "github-actions-daily-job"
        });

        const update = {
          earningScheduleStartedAt: p.earningScheduleStartedAt || admin.firestore.Timestamp.fromMillis(effectiveScheduleStartMs),
          earningScheduleMaxDays: maxCreditDays,
          creditedDays: nextCreditedDays,
          dailyEarningsPaidBDT: roundBDT(Number(p.dailyEarningsPaidBDT || 0) + earnings),
          lastEarningCreditAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        if (matured) {
          update.status = "completed";
          update.completedAt = admin.firestore.FieldValue.serverTimestamp();
          update.maturityEarningsBDT = roundBDT(Number(p.dailyEarningsPaidBDT || 0) + earnings);
          update.maturityPayoutBDT = principalReturn;
        }
        tx.update(packageRef, update);

        return { earnings, principalReturn, matured };
      });

      if (result) {
        creditedPackages++;
        creditedEarnings = roundBDT(creditedEarnings + result.earnings);
        returnedPrincipal = roundBDT(returnedPrincipal + result.principalReturn);
      }
    } catch (error) {
      skipped++;
      console.error("Package failed:", packageDoc.id, error.message);
    }
  }

  console.log(JSON.stringify({
    checked: packagesSnap.size,
    creditedPackages,
    creditedEarningsBDT: creditedEarnings,
    returnedPrincipalBDT: returnedPrincipal,
    skipped
  }, null, 2));

  await admin.app().delete();
  if (skipped > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
