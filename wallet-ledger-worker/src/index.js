const FIREBASE_JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const encoder = new TextEncoder();
let jwksCache = { keys: null, expiresAt: 0 };
let serviceTokenCache = { token: null, expiresAt: 0 };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function base64urlBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function base64url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64urlBytes(segment)));
}
function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return base64urlBytes(body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""));
}
async function loadFirebaseKeys() {
  if (jwksCache.keys && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(FIREBASE_JWKS_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error("Unable to retrieve Firebase signing keys.");
  const body = await response.json();
  jwksCache = { keys: body.keys || [], expiresAt: Date.now() + 5 * 60 * 1000 };
  return jwksCache.keys;
}
async function verifyFirebaseIdToken(token, projectId) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid bearer token.");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported token signing algorithm.");
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId || claims.iss !== "https://securetoken.google.com/" + projectId
    || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128
    || !Number.isFinite(claims.exp) || claims.exp <= now
    || !Number.isFinite(claims.iat) || claims.iat > now + 60
    || !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60) {
    throw new Error("Firebase token claims are invalid or expired.");
  }
  const jwk = (await loadFirebaseKeys()).find(key => key.kid === header.kid);
  if (!jwk) throw new Error("Firebase signing key not found.");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signingInput = encoder.encode(parts[0] + "." + parts[1]);
  const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, base64urlBytes(parts[2]), signingInput);
  if (!valid) throw new Error("Firebase token signature is invalid.");
  return claims;
}
async function createServiceAccountAccessToken(env) {
  if (serviceTokenCache.token && serviceTokenCache.expiresAt > Date.now() + 60_000) return serviceTokenCache.token;
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!account.client_email || !account.private_key) throw new Error("Firebase service account secret is not configured.");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + base64url(JSON.stringify({
    iss: account.client_email, scope: FIRESTORE_SCOPE, aud: OAUTH_TOKEN_URL, iat: now, exp: now + 3600
  }));
  const key = await crypto.subtle.importKey("pkcs8", pemToBytes(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, encoder.encode(unsigned));
  const assertion = unsigned + "." + base64url(new Uint8Array(signature));
  const form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  const response = await fetch(OAUTH_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error("Could not obtain Firestore access token.");
  serviceTokenCache = { token: body.access_token, expiresAt: Date.now() + Math.max(60, Number(body.expires_in || 3600)) * 1000 };
  return body.access_token;
}
function firestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  return null;
}
function firestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, firestoreValue(value)]));
}
async function getLedger(env, uid) {
  const token = await createServiceAccountAccessToken(env);
  const url = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(env.FIREBASE_PROJECT_ID)
    + "/databases/(default)/documents/walletLedgers/" + encodeURIComponent(uid);
  const response = await fetch(url, { headers: { authorization: "Bearer " + token } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Firestore ledger read failed.");
  const document = await response.json();
  return firestoreFields(document.fields || {});
}
function sourceBalance(ledger, availableField, pendingField) {
  const available = Number(ledger[availableField] || 0);
  const pending = Number(ledger[pendingField] || 0);
  if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(pending) || pending < 0 || pending > available) {
    throw new Error("Wallet ledger contains invalid amounts.");
  }
  return { balancePoisha: available, pendingWithdrawalPoisha: pending, withdrawablePoisha: available - pending };
}
function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type", "vary": "origin" };
}


function parseBatchGetResponse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    // Firestore batchGet is a streaming endpoint: it may return adjacent JSON
    // objects rather than a single JSON array. Parse each complete JSON line.
    return trimmed.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
}
function firestoreString(value) { return { stringValue: String(value) }; }
function firestoreInteger(value) { return { integerValue: String(value) }; }
function firestoreTimestamp(value) { return { timestampValue: new Date(value).toISOString() }; }
function encodeFields(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = firestoreString(item);
    else if (Number.isSafeInteger(item)) out[key] = firestoreInteger(item);
    else if (typeof item === "number" && Number.isFinite(item)) out[key] = { doubleValue: item };
    else if (item instanceof Date) out[key] = firestoreTimestamp(item);
    else if (typeof item === "boolean") out[key] = { booleanValue: item };
    else if (item === null) out[key] = { nullValue: null };
  }
  return out;
}
async function firestorePost(env, path, body, token) {
  const accessToken = token || await createServiceAccountAccessToken(env);
  const endpoint = path.startsWith("documents:") ? path : "documents/" + path;
  const response = await fetch("https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(env.FIREBASE_PROJECT_ID)
    + "/databases/(default)/" + endpoint, {
      method: "POST",
      headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  const raw = await response.text();
  if (!response.ok) throw new Error("Firestore transaction request failed (" + response.status + ").");
  if (path === "documents:batchGet" || path === "documents:runQuery") return parseBatchGetResponse(raw);
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { throw new Error("Firestore returned an invalid response."); }
}
async function purchasePackage(env, uid, input) {
  const amountBDT = Number(input.amountBDT);
  const allowed = [1000, 2000, 5000, 10000, 20000, 50000];
  const propertyId = String(input.propertyId || "").trim();
  const propertyTitle = String(input.propertyTitle || "").trim().slice(0, 160);
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (!allowed.includes(amountBDT) || !Number.isSafeInteger(amountBDT)) throw new Error("INVALID_PACKAGE_AMOUNT");
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(propertyId) || !propertyTitle) throw new Error("INVALID_PROPERTY");
  const packageId = crypto.randomUUID().replace(/-/g, "");
  const entryId = uid + "_" + idempotencyKey;
  const ledgerPath = "walletLedgers/" + encodeURIComponent(uid);
  const settingsPath = "siteSettings/propertyProfit";
  const entryPath = "walletLedgerEntries/" + encodeURIComponent(entryId);
  const packagePath = "activePackages/" + packageId;
  const token = await createServiceAccountAccessToken(env);
  const begun = await firestorePost(env, "documents:beginTransaction", { options: { readWrite: {} } }, token);
  const transaction = begun.transaction;
  if (!transaction) throw new Error("FIRESTORE_TRANSACTION_START_FAILED");
  try {
    const docs = await firestorePost(env, "documents:batchGet", {
      documents: [
        "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + ledgerPath,
        "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + settingsPath,
        "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + entryPath
      ],
      transaction
    }, token);
    const found = {};
    for (const item of (Array.isArray(docs) ? docs : [])) {
      if (item.found) found[item.found.name.split("/documents/")[1]] = item.found;
    }
    if (found[entryPath]) {
      await firestorePost(env, "documents:rollback", { transaction }, token).catch(() => {});
      return { duplicate: true, message: "This package purchase was already processed." };
    }
    const ledgerDoc = found[ledgerPath], settingsDoc = found[settingsPath];
    if (!ledgerDoc || Number(firestoreFields(ledgerDoc.fields || {}).schemaVersion || 0) < 1) {
      throw new Error("MIGRATION_PENDING");
    }
    const ledger = firestoreFields(ledgerDoc.fields || {});
    const deposit = Number(ledger.depositAvailablePoisha || 0);
    const principal = Number(ledger.packagePrincipalPoisha || 0);
    const amountPoisha = amountBDT * 100;
    if (!Number.isSafeInteger(deposit) || deposit < amountPoisha || !Number.isSafeInteger(principal) || principal < 0) {
      throw new Error(deposit < amountPoisha ? "INSUFFICIENT_DEPOSIT_BALANCE" : "INVALID_LEDGER_BALANCE");
    }
    const dailyRate = settingsDoc ? Number(firestoreFields(settingsDoc.fields || {}).dailyRate) : 0.02;
    if (!Number.isFinite(dailyRate) || dailyRate < 0 || dailyRate > 1) throw new Error("INVALID_PROFIT_RATE");
    const now = new Date();
    const maturityAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const ledgerName = "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + ledgerPath;
    const writes = [
      {
        update: { name: ledgerName, fields: encodeFields({
          ...ledger,
          depositAvailablePoisha: deposit - amountPoisha,
          packagePrincipalPoisha: principal + amountPoisha,
          updatedAt: now
        }) },
        updateMask: { fieldPaths: ["depositAvailablePoisha", "packagePrincipalPoisha", "updatedAt"] },
        currentDocument: { updateTime: ledgerDoc.updateTime }
      },
      {
        update: { name: "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + packagePath,
          fields: encodeFields({
            uid, propertyId, propertyTitle, amountBDT, dailyRate,
            hourlyRate: dailyRate / 24, termDays: 30, maturityAt,
            status: "active", startedAt: now, createdAt: now
          }) },
        currentDocument: { exists: false }
      },
      {
        update: { name: "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + entryPath,
          fields: encodeFields({
            uid, type: "package-purchase", source: "deposit", amountPoisha,
            packageId, idempotencyKey, createdAt: now
          }) },
        currentDocument: { exists: false }
      }
    ];
    await firestorePost(env, "documents:commit", { writes, transaction }, token);
    return { duplicate: false, packageId, amountBDT, depositBalanceBDT: (deposit - amountPoisha) / 100, packageBalanceBDT: (principal + amountPoisha) / 100 };
  } catch (error) {
    await firestorePost(env, "documents:rollback", { transaction }, token).catch(() => {});
    throw error;
  }
}


const LEDGER_FIELDS = {
  deposit: ["depositAvailablePoisha", "pendingDepositWithdrawalPoisha"],
  package: ["packagePrincipalPoisha", "pendingPackageWithdrawalPoisha"],
  profit: ["profitAvailablePoisha", "pendingProfitWithdrawalPoisha"]
};
function docName(env, path) {
  return "projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/" + path;
}
async function readDocument(env, path, token) {
  const response = await fetch("https://firestore.googleapis.com/v1/" + docName(env, path), { headers: { authorization: "Bearer " + token } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("FIRESTORE_READ_FAILED");
  return response.json();
}
async function beginTxn(env, token) {
  const result = await firestorePost(env, "documents:beginTransaction", { options: { readWrite: {} } }, token);
  if (!result.transaction) throw new Error("FIRESTORE_TRANSACTION_START_FAILED");
  return result.transaction;
}
async function batchRead(env, paths, transaction, token) {
  const result = await firestorePost(env, "documents:batchGet", { documents: paths.map(path => docName(env, path)), transaction }, token);
  const found = {};
  for (const item of result) if (item.found) found[item.found.name.split("/documents/")[1]] = item.found;
  return found;
}
function updateDocWrite(env, path, document, fields, mask) {
  return { update: { name: docName(env, path), fields: encodeFields(fields) }, updateMask: { fieldPaths: mask }, currentDocument: { updateTime: document.updateTime } };
}
function createDocWrite(env, path, fields) {
  return { update: { name: docName(env, path), fields: encodeFields(fields) }, currentDocument: { exists: false } };
}
async function commitTxn(env, transaction, writes, token) {
  await firestorePost(env, "documents:commit", { writes, transaction }, token);
}
async function rollbackTxn(env, transaction, token) {
  await firestorePost(env, "documents:rollback", { transaction }, token).catch(() => {});
}
async function requireAdmin(env, uid, token) {
  const admin = await readDocument(env, "admins/" + uid, token);
  const data = admin ? firestoreFields(admin.fields || {}) : {};
  if (!admin || data.role !== "admin" || data.active !== true) throw new Error("ADMIN_REQUIRED");
}
function amountToPoisha(value, allowZero = false) {
  const amount = Number(value);
  const poisha = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0) || amount > 100000000
    || !Number.isSafeInteger(poisha) || Math.abs(amount * 100 - poisha) > 0.000001) {
    throw new Error("INVALID_AMOUNT");
  }
  return poisha;
}
async function requestWithdrawal(env, uid, input) {
  const source = String(input.source || "");
  if (!Object.hasOwn(LEDGER_FIELDS, source)) throw new Error("INVALID_WITHDRAWAL_SOURCE");
  const amountPoisha = amountToPoisha(input.amountBDT);
  const method = String(input.paymentMethod || "").trim().slice(0, 40);
  const account = String(input.walletNumber || "").trim().slice(0, 120);
  if (!method || !account) throw new Error("PAYOUT_DETAILS_REQUIRED");
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const requestPath = "propertyEnquiries/" + requestId;
  const ledgerPath = "walletLedgers/" + uid;
  const token = await createServiceAccountAccessToken(env);
  const transaction = await beginTxn(env, token);
  try {
    const packageId = source === "package" ? String(input.packageId || "") : "";
    if (source === "package" && !/^[A-Za-z0-9_-]{1,120}$/.test(packageId)) throw new Error("PACKAGE_ID_REQUIRED");
    const paths = [ledgerPath];
    if (packageId) paths.push("activePackages/" + packageId);
    const docs = await batchRead(env, paths, transaction, token);
    const ledgerDoc = docs[ledgerPath];
    if (!ledgerDoc) throw new Error("MIGRATION_PENDING");
    const ledger = firestoreFields(ledgerDoc.fields || {});
    if (Number(ledger.schemaVersion || 0) !== 1) throw new Error("MIGRATION_PENDING");
    const [availableField, pendingField] = LEDGER_FIELDS[source];
    const available = Number(ledger[availableField] || 0), pending = Number(ledger[pendingField] || 0);
    if (!Number.isSafeInteger(available) || !Number.isSafeInteger(pending) || available < 0 || pending < 0 || pending > available) throw new Error("INVALID_LEDGER_BALANCE");
    if (available - pending < amountPoisha) throw new Error("INSUFFICIENT_BALANCE");
    let packageDoc = null;
    if (source === "package") {
      packageDoc = docs["activePackages/" + packageId];
      if (!packageDoc) throw new Error("PACKAGE_NOT_FOUND");
      const p = firestoreFields(packageDoc.fields || {});
      const principal = amountToPoisha(p.amountBDT);
      if (p.uid !== uid || p.status !== "active" || principal !== amountPoisha || p.withdrawalRequestId) throw new Error("PACKAGE_WITHDRAWAL_MUST_MATCH_FULL_ACTIVE_PACKAGE");
    }
    const now = new Date();
    const writes = [
      updateDocWrite(env, ledgerPath, ledgerDoc, { ...ledger, [pendingField]: pending + amountPoisha, updatedAt: now }, [pendingField, "updatedAt"]),
      createDocWrite(env, requestPath, { uid, requestType: "wallet-withdraw", status: "pending", amountBDT: Number(input.amountBDT), source, paymentMethod: method, walletNumber: account, reservedFunds: true, packageId: packageId || "", createdAt: now, ledgerRequestId: requestId, publicId: String(input.publicId || "").slice(0, 32), email: String(input.email || "").slice(0, 160), name: String(input.name || "").slice(0, 100), adminPayoutAccount: String(input.adminPayoutAccount || "").slice(0, 120) })
    ];
    if (packageDoc) {
      const p = firestoreFields(packageDoc.fields || {});
      writes.push(updateDocWrite(env, "activePackages/" + packageId, packageDoc, { ...p, status: "withdrawal_pending", withdrawalRequestId: requestId, updatedAt: now }, ["status", "withdrawalRequestId", "updatedAt"]));
    }
    await commitTxn(env, transaction, writes, token);
    return { requestId, source, amountBDT: Number(input.amountBDT), status: "pending" };
  } catch (error) {
    await rollbackTxn(env, transaction, token);
    throw error;
  }
}
async function decideWalletRequest(env, adminUid, input) {
  const requestId = String(input.requestId || ""), action = String(input.action || "");
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(requestId) || !["approve", "reject"].includes(action)) throw new Error("INVALID_REVIEW_ACTION");
  const token = await createServiceAccountAccessToken(env);
  await requireAdmin(env, adminUid, token);
  const transaction = await beginTxn(env, token);
  try {
    const requestPath = "propertyEnquiries/" + requestId;
    const docs = await batchRead(env, [requestPath], transaction, token);
    const requestDoc = docs[requestPath];
    if (!requestDoc) throw new Error("REQUEST_NOT_FOUND");
    const r = firestoreFields(requestDoc.fields || {});
    if (r.requestType !== "wallet-deposit" && r.requestType !== "wallet-withdraw") throw new Error("UNSUPPORTED_REQUEST_TYPE");
    if (r.status !== "pending") throw new Error("REQUEST_ALREADY_PROCESSED");
    const now = new Date(), writes = [];
    if (r.requestType === "wallet-deposit") {
      if (action === "approve") {
        const amountPoisha = amountToPoisha(r.amountBDT), ledgerPath = "walletLedgers/" + r.uid, walletPath = "wallets/" + r.uid;
        const ledgerDocs = await batchRead(env, [ledgerPath, walletPath], transaction, token), ledgerDoc = ledgerDocs[ledgerPath];
        if (!ledgerDoc) {
          if (ledgerDocs[walletPath]) throw new Error("MIGRATION_PENDING");
          writes.push(createDocWrite(env, ledgerPath, {
            uid: r.uid, schemaVersion: 1, currency: "BDT",
            depositAvailablePoisha: amountPoisha, pendingDepositWithdrawalPoisha: 0,
            packagePrincipalPoisha: 0, pendingPackageWithdrawalPoisha: 0,
            profitAvailablePoisha: 0, pendingProfitWithdrawalPoisha: 0,
            createdAt: now, updatedAt: now
          }));
        } else {
          const ledger = firestoreFields(ledgerDoc.fields || {});
          if (Number(ledger.schemaVersion || 0) !== 1) throw new Error("MIGRATION_PENDING");
          const next = Number(ledger.depositAvailablePoisha || 0) + amountPoisha;
          if (!Number.isSafeInteger(next)) throw new Error("INVALID_LEDGER_BALANCE");
          writes.push(updateDocWrite(env, ledgerPath, ledgerDoc, { ...ledger, depositAvailablePoisha: next, updatedAt: now }, ["depositAvailablePoisha", "updatedAt"]));
        }
        writes.push(createDocWrite(env, "walletLedgerEntries/deposit_" + requestId, { uid: r.uid, type: "deposit-credit", requestId, amountPoisha, createdAt: now, adminUid }));
      }
    } else {
      const source = String(r.source || "");
      if (!Object.hasOwn(LEDGER_FIELDS, source) || r.reservedFunds !== true) throw new Error("LEGACY_WITHDRAWAL_REQUIRES_MANUAL_RECONCILIATION");
      const amountPoisha = amountToPoisha(r.amountBDT), [availableField, pendingField] = LEDGER_FIELDS[source];
      const ledgerPath = "walletLedgers/" + r.uid, paths = [ledgerPath];
      if (source === "package") paths.push("activePackages/" + String(r.packageId || ""));
      const ledgerDocs = await batchRead(env, paths, transaction, token), ledgerDoc = ledgerDocs[ledgerPath];
      if (!ledgerDoc) throw new Error("MIGRATION_PENDING");
      const ledger = firestoreFields(ledgerDoc.fields || {}), available = Number(ledger[availableField] || 0), pending = Number(ledger[pendingField] || 0);
      if (!Number.isSafeInteger(available) || !Number.isSafeInteger(pending) || pending < amountPoisha || available < amountPoisha) throw new Error("WITHDRAWAL_RESERVE_MISMATCH");
      const updated = { ...ledger, [pendingField]: pending - amountPoisha, updatedAt: now };
      if (action === "approve") updated[availableField] = available - amountPoisha;
      writes.push(updateDocWrite(env, ledgerPath, ledgerDoc, updated, [availableField, pendingField, "updatedAt"]));
      if (source === "package") {
        const packageId = String(r.packageId || ""), packageDoc = ledgerDocs["activePackages/" + packageId];
        if (!packageDoc) throw new Error("PACKAGE_NOT_FOUND");
        const p = firestoreFields(packageDoc.fields || {});
        if (p.uid !== r.uid || p.status !== "withdrawal_pending" || p.withdrawalRequestId !== requestId) throw new Error("PACKAGE_STATE_MISMATCH");
        writes.push(updateDocWrite(env, "activePackages/" + packageId, packageDoc, { ...p, status: action === "approve" ? "withdrawn" : "active", withdrawalRequestId: "", updatedAt: now }, ["status", "withdrawalRequestId", "updatedAt"]));
      }
      writes.push(createDocWrite(env, "walletLedgerEntries/" + (action === "approve" ? "withdrawal_" : "withdrawal_reject_") + requestId, { uid: r.uid, type: action === "approve" ? "withdrawal-debit" : "withdrawal-release", requestId, source, amountPoisha, adminUid, createdAt: now }));
    }
    writes.push(updateDocWrite(env, requestPath, requestDoc, { ...r, status: action === "approve" ? "approved" : "rejected", reviewedAt: now, reviewedBy: adminUid }, ["status", "reviewedAt", "reviewedBy"]));
    await commitTxn(env, transaction, writes, token);
    return { requestId, status: action === "approve" ? "approved" : "rejected" };
  } catch (error) {
    await rollbackTxn(env, transaction, token);
    throw error;
  }
}
async function accruePackageProfit(env, adminUid, packageId) {
  const token = await createServiceAccountAccessToken(env);
  await requireAdmin(env, adminUid, token);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(packageId)) throw new Error("PACKAGE_ID_REQUIRED");
  const path = "activePackages/" + packageId, transaction = await beginTxn(env, token);
  try {
    const docs = await batchRead(env, [path], transaction, token), packageDoc = docs[path];
    if (!packageDoc) throw new Error("PACKAGE_NOT_FOUND");
    const p = firestoreFields(packageDoc.fields || {});
    if (p.status !== "active") { await rollbackTxn(env, transaction, token); return { skipped: true, reason: "not-active" }; }
    const startedAt = Date.parse(p.startedAt || "");
    if (!Number.isFinite(startedAt)) throw new Error("PACKAGE_START_DATE_INVALID");
    const termDays = Math.max(1, Math.min(365, Number(p.termDays || 30))), principalPoisha = amountToPoisha(p.amountBDT), rate = Number(p.dailyRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error("INVALID_PROFIT_RATE");
    const nowMs = Date.now(), elapsedDays = Math.min(termDays, Math.floor((nowMs - startedAt) / 86400000));
    const creditedDays = Math.max(0, Number(p.creditedDays || 0)), dueDays = Math.max(0, elapsedDays - creditedDays);
    if (!dueDays) { await rollbackTxn(env, transaction, token); return { skipped: true, reason: "not-due" }; }
    const earningsPoisha = Math.round(principalPoisha * rate * dueDays), ledgerPath = "walletLedgers/" + p.uid;
    const ledgerDocs = await batchRead(env, [ledgerPath], transaction, token), ledgerDoc = ledgerDocs[ledgerPath];
    if (!ledgerDoc) throw new Error("MIGRATION_PENDING");
    const ledger = firestoreFields(ledgerDoc.fields || {});
    if (Number(ledger.schemaVersion || 0) !== 1) throw new Error("MIGRATION_PENDING");
    const nextProfit = Number(ledger.profitAvailablePoisha || 0) + earningsPoisha, matured = elapsedDays >= termDays;
    const nextPrincipal = Number(ledger.packagePrincipalPoisha || 0) - (matured ? principalPoisha : 0);
    const nextDeposit = Number(ledger.depositAvailablePoisha || 0) + (matured ? principalPoisha : 0);
    if (!Number.isSafeInteger(nextProfit) || nextPrincipal < 0 || !Number.isSafeInteger(nextDeposit)) throw new Error("INVALID_LEDGER_BALANCE");
    const now = new Date(), nextCreditedDays = creditedDays + dueDays;
    const writes = [
      updateDocWrite(env, ledgerPath, ledgerDoc, { ...ledger, profitAvailablePoisha: nextProfit, packagePrincipalPoisha: nextPrincipal, depositAvailablePoisha: nextDeposit, updatedAt: now }, ["profitAvailablePoisha", "packagePrincipalPoisha", "depositAvailablePoisha", "updatedAt"]),
      updateDocWrite(env, path, packageDoc, { ...p, creditedDays: nextCreditedDays, lastProfitAccruedAt: now, status: matured ? "completed" : "active", completedAt: matured ? now : null, updatedAt: now }, ["creditedDays", "lastProfitAccruedAt", "status", "completedAt", "updatedAt"]),
      createDocWrite(env, "walletLedgerEntries/profit_" + packageId + "_day_" + nextCreditedDays, { uid: p.uid, packageId, type: "profit-credit", amountPoisha: earningsPoisha, daysCredited: dueDays, principalReturnedPoisha: matured ? principalPoisha : 0, createdAt: now })
    ];
    await commitTxn(env, transaction, writes, token);
    return { packageId, daysCredited: dueDays, profitBDT: earningsPoisha / 100, principalReturnedBDT: matured ? principalPoisha / 100 : 0, matured };
  } catch (error) {
    await rollbackTxn(env, transaction, token);
    throw error;
  }
}


async function listActivePackages(env, uid, token) {
  const where = uid
    ? { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } },
        { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } }
      ] } }
    : { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "active" } } };
  const rows = await firestorePost(env, "documents:runQuery", {
    structuredQuery: { from: [{ collectionId: "activePackages" }], where, limit: 400 }
  }, token);
  return rows.map(row => row.document).filter(Boolean);
}
async function migrateMemberLedger(env, adminUid, input) {
  const uid = String(input.uid || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error("INVALID_MEMBER_UID");
  const token = await createServiceAccountAccessToken(env);
  await requireAdmin(env, adminUid, token);
  const depositPoisha = amountToPoisha(input.depositBDT || 0, true);
  const profitPoisha = amountToPoisha(input.profitBDT || 0, true);
  const packagePoisha = amountToPoisha(input.packageBDT || 0, true);
  const packages = await listActivePackages(env, uid, token);
  if (packages.length > 400) throw new Error("TOO_MANY_ACTIVE_PACKAGES");
  let calculatedPackagePoisha = 0;
  const packagePaths = packages.map(doc => {
    const fields = firestoreFields(doc.fields || {});
    if (fields.uid !== uid || fields.status !== "active") throw new Error("PACKAGE_MIGRATION_REVIEW_FAILED");
    const amount = fields.amountBDT != null ? Number(fields.amountBDT) : Number(fields.amountUSD || 0) * Number(fields.exchangeRateBDT || 0);
    const poisha = Math.round(amount * 100);
    if (!Number.isSafeInteger(poisha) || poisha <= 0) throw new Error("PACKAGE_MIGRATION_REVIEW_FAILED");
    calculatedPackagePoisha += poisha;
    return doc.name.split("/documents/")[1];
  });
  if (calculatedPackagePoisha !== packagePoisha) throw new Error("PACKAGE_TOTAL_MISMATCH");
  const walletPath = "wallets/" + uid, ledgerPath = "walletLedgers/" + uid, migrationPath = "walletLedgerMigrations/" + uid;
  const walletDoc = await readDocument(env, walletPath, token);
  if (!walletDoc) throw new Error("LEGACY_WALLET_NOT_FOUND");
  const wallet = firestoreFields(walletDoc.fields || {});
  const settingsDoc = await readDocument(env, "siteSettings/wallet", token);
  const settings = settingsDoc ? firestoreFields(settingsDoc.fields || {}) : {};
  let legacyBalance = wallet.balanceBDT == null ? NaN : Number(wallet.balanceBDT);
  if (!Number.isFinite(legacyBalance)) {
    const usd = Number(wallet.balanceUSD || 0), rate = Number(settings.exchangeRateBDT || 0);
    if (!Number.isFinite(usd) || usd < 0 || (usd > 0 && (!Number.isFinite(rate) || rate <= 0))) throw new Error("LEGACY_WALLET_BALANCE_UNRESOLVED");
    legacyBalance = usd * rate;
  }
  const legacyPoisha = Math.round(legacyBalance * 100);
  if (!Number.isSafeInteger(legacyPoisha) || legacyPoisha < 0 || depositPoisha + profitPoisha !== legacyPoisha) throw new Error("LEGACY_BALANCE_SPLIT_MISMATCH");
  if (Number(wallet.pendingWithdrawalBDT || 0) > 0) throw new Error("LEGACY_PENDING_WITHDRAWALS_REQUIRE_REVIEW");
  const transaction = await beginTxn(env, token);
  try {
    const paths = [walletPath, ledgerPath, migrationPath, ...packagePaths];
    const docs = await batchRead(env, paths, transaction, token);
    if (!docs[walletPath]) throw new Error("MIGRATION_STATE_CHANGED");
    if (docs[ledgerPath] || docs[migrationPath]) throw new Error("LEDGER_ALREADY_EXISTS");
    const currentWallet = firestoreFields(docs[walletPath].fields || {});
    const currentBalance = Number.isFinite(Number(currentWallet.balanceBDT))
      ? Math.round(Number(currentWallet.balanceBDT) * 100)
      : legacyPoisha;
    if (currentBalance !== legacyPoisha) throw new Error("LEGACY_BALANCE_CHANGED");
    const writes = [
      createDocWrite(env, ledgerPath, {
        uid, schemaVersion: 1, currency: "BDT",
        depositAvailablePoisha: depositPoisha, pendingDepositWithdrawalPoisha: 0,
        packagePrincipalPoisha: packagePoisha, pendingPackageWithdrawalPoisha: 0,
        profitAvailablePoisha: profitPoisha, pendingProfitWithdrawalPoisha: 0,
        migratedAt: new Date(), updatedAt: new Date()
      }),
      createDocWrite(env, migrationPath, {
        uid, status: "completed", legacyWalletBalancePoisha: legacyPoisha,
        depositPoisha, packagePoisha, profitPoisha,
        activePackageCount: packages.length, reviewedBy: adminUid,
        createdAt: new Date(), classification: "admin-reviewed-explicit-split"
      })
    ];
    await commitTxn(env, transaction, writes, token);
    return { uid, migrated: true, depositBDT: depositPoisha / 100, packageBDT: packagePoisha / 100, profitBDT: profitPoisha / 100, activePackages: packages.length };
  } catch (error) {
    await rollbackTxn(env, transaction, token);
    throw error;
  }
}
async function runScheduledProfitAccrual(env) {
  const token = await createServiceAccountAccessToken(env);
  const packages = await listActivePackages(env, "", token);
  const results = [];
  for (const document of packages) {
    const id = document.name.split("/").pop();
    try { results.push(await accruePackageProfit(env, "", id)); }
    catch (error) { results.push({ packageId: id, error: String(error.message || "FAILED") }); }
  }
  return results;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledProfitAccrual(env).then(results => {
      console.log(JSON.stringify({ scheduledProfitAccrual: results.length, failures: results.filter(x => x.error).length }));
    }));
  },
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "property-zone-wallet-ledger", mode: "segregated-ledger-staged" }, 200, cors);
    }
    const routes = new Map([
      ["/v1/wallet-summary", "GET"], ["/v1/package-purchase", "POST"],
      ["/v1/withdrawal-request", "POST"], ["/v1/admin/wallet-decision", "POST"],
      ["/v1/admin/profit-accrual", "POST"], ["/v1/admin/migrate-member", "POST"]
    ]);
    if (!routes.has(url.pathname) || routes.get(url.pathname) !== request.method) return json({ error: "NOT_FOUND" }, 404, cors);
    try {
      if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
        return json({ error: "BACKEND_NOT_CONFIGURED" }, 503, cors);
      }
      const authorization = request.headers.get("authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) return json({ error: "AUTH_REQUIRED" }, 401, cors);
      const claims = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
      if (url.pathname !== "/v1/wallet-summary") {
        let input;
        try { input = await request.json(); } catch (_) { return json({ error: "INVALID_JSON" }, 400, cors); }
        let result;
        if (url.pathname === "/v1/package-purchase") result = await purchasePackage(env, claims.sub, input || {});
        else if (url.pathname === "/v1/withdrawal-request") result = await requestWithdrawal(env, claims.sub, input || {});
        else if (url.pathname === "/v1/admin/wallet-decision") result = await decideWalletRequest(env, claims.sub, input || {});
        else if (url.pathname === "/v1/admin/profit-accrual") result = await accruePackageProfit(env, claims.sub, String(input.packageId || ""));
        else if (url.pathname === "/v1/admin/migrate-member") result = await migrateMemberLedger(env, claims.sub, input || {});
        return json({ ok: true, ...result }, 200, cors);
      }
      const ledger = await getLedger(env, claims.sub);
      if (!ledger || Number(ledger.schemaVersion || 0) < 1) {
        return json({ error: "MIGRATION_PENDING", message: "Wallet ledger is not enabled for this account." }, 409, cors);
      }
      const deposit = sourceBalance(ledger, "depositAvailablePoisha", "pendingDepositWithdrawalPoisha");
      const packageFunds = sourceBalance(ledger, "packagePrincipalPoisha", "pendingPackageWithdrawalPoisha");
      const profit = sourceBalance(ledger, "profitAvailablePoisha", "pendingProfitWithdrawalPoisha");
      return json({
        uid: claims.sub,
        currency: "BDT",
        balances: {
          deposit: { ...deposit, withdrawableBDT: deposit.withdrawablePoisha / 100 },
          package: { ...packageFunds, withdrawableBDT: packageFunds.withdrawablePoisha / 100 },
          profit: { ...profit, withdrawableBDT: profit.withdrawablePoisha / 100 }
        },
        mode: "read-only"
      }, 200, cors);
    } catch (error) {
      const message = String(error && error.message || "");
      const authError = /token|bearer|signature|claims|signing key/i.test(message);
      const clientErrors = new Set(["MIGRATION_PENDING", "INSUFFICIENT_DEPOSIT_BALANCE", "INVALID_PACKAGE_AMOUNT", "INVALID_IDEMPOTENCY_KEY", "INVALID_PROPERTY", "INVALID_LEDGER_BALANCE", "INVALID_PROFIT_RATE", "INVALID_AMOUNT", "INVALID_WITHDRAWAL_SOURCE", "PAYOUT_DETAILS_REQUIRED", "INSUFFICIENT_BALANCE", "PACKAGE_ID_REQUIRED", "PACKAGE_NOT_FOUND", "PACKAGE_WITHDRAWAL_MUST_MATCH_FULL_ACTIVE_PACKAGE", "ADMIN_REQUIRED", "INVALID_REVIEW_ACTION", "REQUEST_NOT_FOUND", "REQUEST_ALREADY_PROCESSED", "UNSUPPORTED_REQUEST_TYPE", "LEGACY_WITHDRAWAL_REQUIRES_MANUAL_RECONCILIATION", "WITHDRAWAL_RESERVE_MISMATCH", "PACKAGE_STATE_MISMATCH", "PACKAGE_START_DATE_INVALID", "PROFIT_SCHEDULE_INVALID", "INVALID_MEMBER_UID", "TOO_MANY_ACTIVE_PACKAGES", "PACKAGE_MIGRATION_REVIEW_FAILED", "PACKAGE_TOTAL_MISMATCH", "LEGACY_WALLET_NOT_FOUND", "LEGACY_WALLET_BALANCE_UNRESOLVED", "LEGACY_BALANCE_SPLIT_MISMATCH", "LEGACY_PENDING_WITHDRAWALS_REQUIRE_REVIEW", "MIGRATION_STATE_CHANGED", "LEDGER_ALREADY_EXISTS", "LEGACY_BALANCE_CHANGED"]);
      const status = authError ? 401 : message === "ADMIN_REQUIRED" ? 403 : clientErrors.has(message) ? (["MIGRATION_PENDING", "INSUFFICIENT_DEPOSIT_BALANCE", "INSUFFICIENT_BALANCE", "REQUEST_ALREADY_PROCESSED"].includes(message) ? 409 : 400) : 500;
      return json({ error: authError ? "UNAUTHORIZED" : clientErrors.has(message) ? message : "BACKEND_ERROR" }, status, cors);
    }
  }
};


export { firestoreValue, firestoreFields, sourceBalance, purchasePackage, parseBatchGetResponse, amountToPoisha, requestWithdrawal, decideWalletRequest, accruePackageProfit, migrateMemberLedger, runScheduledProfitAccrual };
