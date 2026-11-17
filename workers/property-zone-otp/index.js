const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:cors});
const FIREBASE_WEB_API_KEY = "AIzaSyDRLWFf4ISfQdoZp7JaQAWwwKCoL_aV6No";
const b64url = (value) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/=/g,"").replace(/\\+/g,"-").replace(/\\//g,"_");
};
const normalizePhone = (value) => {
  let p=String(value||"").replace(/[^0-9]/g,"");
  if(p.startsWith("00880")) p=p.slice(2);
  if(p.startsWith("01") && p.length===11) p="88"+p;
  if(p.startsWith("1") && p.length===10) p="880"+p;
  return /^8801[3-9][0-9]{8}$/.test(p) ? "+"+p : null;
};
const one9Phone = (phone) => phone.replace(/^\\+/,"");
async function one9(path, params, env) {
  if(!env.ONE9_API_KEY) throw new Error("SMS gateway is not configured");
  const body=new URLSearchParams({api_key:env.ONE9_API_KEY,...params});
  const res=await fetch("https://sms.one9.one/sms/api"+path,{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},body});
  const raw=await res.text(); let data;
  try{data=JSON.parse(raw)}catch{data={message:raw}}
  const valid=data && (data.success===true || data.status==="success" || ["200","900","0"].includes(String(data.statusCode||data.code||"")));
  if(!res.ok || !valid) throw new Error(data.message||data.reason||"SMS gateway request failed");
  return data;
}
function serviceAccount(env) {
  if(!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Firebase Admin credentials are not configured");
  const service=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if(!service.project_id || !service.client_email || !service.private_key) throw new Error("Firebase service account is incomplete");
  return service;
}
let oauthCache=null;
async function googleAccessToken(env) {
  if(oauthCache && oauthCache.expires>Date.now()+60000) return oauthCache.token;
  const service=serviceAccount(env), now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=b64url(JSON.stringify({iss:service.client_email,scope:"https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/datastore",aud:service.token_uri||"https://oauth2.googleapis.com/token",iat:now,exp:now+3600}));
  const unsigned=header+"."+claim;
  const pem=service.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\s/g,"");
  const binary=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey("pkcs8",binary,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const signature=new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned)));
  const assertion=unsigned+"."+b64url(signature);
  const form=new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion});
  const response=await fetch(service.token_uri||"https://oauth2.googleapis.com/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:form});
  const data=await response.json();
  if(!response.ok || !data.access_token) throw new Error("Firebase service-account authorization failed");
  oauthCache={token:data.access_token,expires:Date.now()+(data.expires_in||3600)*1000};
  return data.access_token;
}
async function adminAuth(env, action, payload) {
  const service=serviceAccount(env), access=await googleAccessToken(env);
  const response=await fetch("https://identitytoolkit.googleapis.com/v1/projects/"+encodeURIComponent(service.project_id)+"/"+action,{
    method:"POST",headers:{"authorization":"Bearer "+access,"content-type":"application/json"},body:JSON.stringify(payload)
  });
  const data=await response.json();
  if(!response.ok) throw new Error(data.error?.message||"Firebase Authentication request failed");
  return data;
}
async function verifyIdToken(idToken) {
  const response=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="+FIREBASE_WEB_API_KEY,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({idToken})
  });
  const data=await response.json();
  if(!response.ok || !data.users?.[0]?.localId) throw new Error("Firebase sign-in session is invalid. Please sign in again.");
  return data.users[0];
}
async function createCustomToken(uid, env) {
  const service=serviceAccount(env), now=Math.floor(Date.now()/1000);
  const header=b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  const claim=b64url(JSON.stringify({iss:service.client_email,sub:service.client_email,aud:"https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",iat:now,exp:now+3600,uid,claims:{}}));
  const unsigned=header+"."+claim;
  const pem=service.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\s/g,"");
  const binary=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));
  const key=await crypto.subtle.importKey("pkcs8",binary,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["sign"]);
  const signature=new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",key,new TextEncoder().encode(unsigned)));
  return unsigned+"."+b64url(signature);
}
async function updateMemberPhone(env, uid, phone) {
  const service=serviceAccount(env), access=await googleAccessToken(env);
  const name="projects/"+service.project_id+"/databases/(default)/documents/members/"+encodeURIComponent(uid);
  const url="https://firestore.googleapis.com/v1/"+name+"?updateMask.fieldPaths=phoneNumber&updateMask.fieldPaths=phoneVerified&updateMask.fieldPaths=updatedAt";
  const response=await fetch(url,{method:"PATCH",headers:{"authorization":"Bearer "+access,"content-type":"application/json"},body:JSON.stringify({fields:{
    phoneNumber:{stringValue:phone},phoneVerified:{booleanValue:true},updatedAt:{timestampValue:new Date().toISOString()}
  }})});
  if(!response.ok) { const err=await response.json(); throw new Error(err.error?.message||"Could not update member profile"); }
}
export default {
 async fetch(request, env) {
  const path=new URL(request.url).pathname.replace(/\\/+$/,"");
  if(request.method==="GET" && (path==="/" || path==="/health")) {
   return json({success:true,worker:"property-zone-otp",otpStorage:!!env.OTP_STORE,one9Configured:!!env.ONE9_API_KEY,firebaseConfigured:!!env.FIREBASE_SERVICE_ACCOUNT_JSON});
  }
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors});
  if(request.method!=="POST") return json({success:false,message:"Method not allowed"},405);
  if(!env.OTP_STORE) return json({success:false,message:"OTP storage is not configured"},500);
  let body; try{body=await request.json()}catch{return json({success:false,message:"Invalid JSON"},400)}
  try {
   if(path.endsWith("/otp-send") || path.endsWith("/otp/send")) {
    const phone=normalizePhone(body.phone||body.to);
    if(!phone) return json({success:false,message:"Enter a valid Bangladesh phone number"},400);
    const key="otp-rate:"+phone, now=Date.now(), prior=await env.OTP_STORE.get(key,{type:"json"});
    if(prior && now-prior.last<60000) return json({success:false,message:"Please wait before requesting another OTP"},429);
    if(prior && prior.count>=5 && now-prior.window<86400000) return json({success:false,message:"Daily OTP limit reached"},429);
    const result=await one9("/otp/send",{to:one9Phone(phone),digits:"6",expiry:"5"},env);
    await env.OTP_STORE.put(key,JSON.stringify({last:now,window:prior?.window||now,count:(prior?.count||0)+1}),{expirationTtl:86400});
    return json({success:true,message:"OTP sent"});
   }
   if(path.endsWith("/otp-verify") || path.endsWith("/otp/verify")) {
    const phone=normalizePhone(body.phone||body.to), otp=String(body.otp||"").trim();
    if(!phone || !/^\\d{6}$/.test(otp)) return json({success:false,message:"Valid phone and 6-digit OTP are required"},400);
    await one9("/otp/verify",{to:one9Phone(phone),otp},env);
    const token=crypto.randomUUID();
    await env.OTP_STORE.put("verified:"+token,phone,{expirationTtl:300});
    return json({success:true,verificationToken:token, message:"OTP verified"});
   }
   if(path.endsWith("/complete-registration")) {
    const phone=normalizePhone(body.phone), idToken=String(body.idToken||""), verificationToken=String(body.verificationToken||"");
    if(!phone||!idToken||!verificationToken) return json({success:false,message:"ফোন যাচাইয়ের তথ্য অসম্পূর্ণ।"},400);
    const verifiedPhone=await env.OTP_STORE.get("verified:"+verificationToken);
    if(!verifiedPhone || verifiedPhone!==phone) return json({success:false,message:"ফোন যাচাইয়ের মেয়াদ শেষ। আবার OTP নিন।"},403);
    const user=await verifyIdToken(idToken);
    const found=await adminAuth(env,"accounts:lookup",{phoneNumber:[phone]});
    const existing=found.users?.[0];
    if(existing && existing.localId!==user.localId) return json({success:false,message:"এই নম্বর অন্য অ্যাকাউন্টে যুক্ত আছে।"},409);
    await adminAuth(env,"accounts:update",{localId:user.localId,phoneNumber:phone});
    await updateMemberPhone(env,user.localId,phone);
    await env.OTP_STORE.delete("verified:"+verificationToken);
    return json({success:true,message:"ফোন নম্বর অ্যাকাউন্টে যুক্ত হয়েছে।"});
   }
   if(path.endsWith("/phone-login")) {
    const phone=normalizePhone(body.phone), password=String(body.password||"");
    if(!phone||!password||password.length>128) return json({success:false,message:"মোবাইল নম্বর ও পাসওয়ার্ড দিন।"},400);
    const found=await adminAuth(env,"accounts:lookup",{phoneNumber:[phone]});
    const user=found.users?.[0];
    if(!user?.email) return json({success:false,message:"এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি।"},404);
    const response=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key="+FIREBASE_WEB_API_KEY,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:user.email,password,returnSecureToken:true})
    });
    const signed=await response.json();
    if(!response.ok || signed.localId!==user.localId) return json({success:false,message:"মোবাইল নম্বর অথবা পাসওয়ার্ড সঠিক নয়।"},401);
    return json({success:true,customToken:await createCustomToken(user.localId,env)});
   }
   return json({success:false,message:"Unknown endpoint"},404);
  } catch(e) {
   const message=String(e.message||"Request failed");
   const status=/INVALID|NOT_FOUND|EMAIL_EXISTS|PHONE_NUMBER_EXISTS/.test(message)?400:502;
   return json({success:false,message},status);
  }
 }
};
