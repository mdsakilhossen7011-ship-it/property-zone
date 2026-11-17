import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createHash, randomBytes } from "node:crypto";

export function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "vary": "Origin"
  }});
}
export function corsOrigin(req) {
  const origin = req.headers.get("origin") || "";
  const allowed = (process.env.PZ_ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : "";
}
export function preflight(req) {
  const origin = corsOrigin(req);
  if (req.method === "OPTIONS") return new Response(null, {status: origin ? 204 : 403, headers: {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  }});
  if (!origin) return new Response("Forbidden", {status: 403});
  if (req.method !== "POST") return json({success:false,message:"Method not allowed."},405,origin);
  return null;
}
export async function readBody(req) { try { return await req.json(); } catch { return null; } }
export function normalizePhone(value) {
  let d = String(value || "").replace(/\D/g, "");
  if (d.startsWith("00880")) d = d.slice(2);
  if (d.startsWith("880")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^1[3-9]\d{8}$/.test(d) ? "+880" + d : null;
}
export function firebase() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Firebase Admin credentials are not configured.");
  if (!getApps().length) {
    const service = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(service) });
  }
  return { auth: getAuth(), db: getFirestore() };
}
export const sha = value => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export function validGateway(data) {
  return data && (data.success === true || data.status === "success" || ["200","900","0"].includes(String(data.statusCode || data.code || "")));
}
export async function one9(path, params) {
  if (!process.env.ONE9_API_KEY) throw new Error("One9 API key is not configured.");
  const form = new URLSearchParams({ api_key: process.env.ONE9_API_KEY, ...params });
  const response = await fetch("https://sms.one9.one/sms/api" + path, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form
  });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = { message: raw }; }
  if (!response.ok || !validGateway(data)) {
    const err = new Error(data?.message || data?.reason || "One9 SMS gateway rejected the request.");
    err.status = response.status || 502;
    throw err;
  }
  return data;
}
