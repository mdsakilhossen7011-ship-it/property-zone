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
  const response = await fetch("https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(env.FIREBASE_PROJECT_ID)
    + "/databases/(default)/documents/" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + accessToken, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Firestore transaction request failed (" + response.status + ").");
  return payload;
}
async function purchasePackage(env, uid, input) {
  const amountBDT = Number(input.amountBDT);
  const allowed = [1000, 2000, 5000, 10000, 20000, 50000, 100000];
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

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "property-zone-wallet-ledger", mode: "read-only-foundation" }, 200, cors);
    }
    if (!["/v1/wallet-summary", "/v1/package-purchase"].includes(url.pathname)
      || (url.pathname === "/v1/wallet-summary" && request.method !== "GET")
      || (url.pathname === "/v1/package-purchase" && request.method !== "POST")) {
      return json({ error: "NOT_FOUND" }, 404, cors);
    }
    try {
      if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_SERVICE_ACCOUNT) {
        return json({ error: "BACKEND_NOT_CONFIGURED" }, 503, cors);
      }
      const authorization = request.headers.get("authorization") || "";
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) return json({ error: "AUTH_REQUIRED" }, 401, cors);
      const claims = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
      if (url.pathname === "/v1/package-purchase") {
        let input;
        try { input = await request.json(); } catch (_) { return json({ error: "INVALID_JSON" }, 400, cors); }
        const result = await purchasePackage(env, claims.sub, input || {});
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
      return json({ error: authError ? "UNAUTHORIZED" : "BACKEND_ERROR" }, authError ? 401 : 500, cors);
    }
  }
};


export { firestoreValue, firestoreFields, sourceBalance, purchasePackage };
