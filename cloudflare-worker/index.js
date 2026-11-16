const ALLOWED_ORIGINS = new Set(["https://mdsakilhossen7011-ship-it.github.io"]);
const OTP_TTL_SECONDS = 300, SEND_COOLDOWN_SECONDS = 60, DAILY_SEND_LIMIT = 5, MAX_VERIFY_ATTEMPTS = 5;
function json(data,status,origin){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Vary":"Origin"}})}
function normalizePhone(value){let d=String(value||"").replace(/[^0-9]/g,"");if(d.startsWith("00880"))d=d.slice(2);if(d.startsWith("880"))d=d.slice(3);if(d.startsWith("0"))d=d.slice(1);return /^1[3-9][0-9]{8}$/.test(d)?"880"+d:null}
function randomDigits(){const a=new Uint32Array(1);crypto.getRandomValues(a);return String(100000+a[0]%900000)}
function randomToken(){const a=new Uint8Array(32);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,"0")).join("")}
async function hash(v){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("")}
async function bodyOf(r){try{return await r.json()}catch{return null}}
export default {async fetch(request,env){
 const origin=request.headers.get("Origin")||"",allowed=ALLOWED_ORIGINS.has(origin)?origin:"";
 if(!allowed)return new Response("Forbidden",{status:403});
 if(request.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":allowed,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"86400","Vary":"Origin"}});
 if(request.method!=="POST")return json({success:false,message:"Method not allowed."},405,allowed);
 if(!env.OTP_STORE)return json({success:false,message:"OTP storage is not configured."},503,allowed);
 const url=new URL(request.url),body=await bodyOf(request);if(!body)return json({success:false,message:"Invalid request."},400,allowed);
 if(url.pathname==="/send-otp"){
  const phone=normalizePhone(body.phone);if(!phone)return json({success:false,message:"Enter a valid Bangladesh mobile number."},400,allowed);
  if(await env.OTP_STORE.get("used:"+phone))return json({success:false,message:"This phone number has already been used for an account."},409,allowed);
  if(await env.OTP_STORE.get("cooldown:"+phone))return json({success:false,message:"Please wait 60 seconds before requesting another OTP."},429,allowed);
  const day=new Date().toISOString().slice(0,10),dailyKey="daily:"+day+":"+phone,sent=Number(await env.OTP_STORE.get(dailyKey)||"0");
  if(sent>=DAILY_SEND_LIMIT)return json({success:false,message:"Daily OTP limit reached for this number. Try again tomorrow."},429,allowed);
  if(!env.BULKSMSBD_API_KEY||!env.BULKSMSBD_SENDER_ID)return json({success:false,message:"SMS gateway is not configured yet."},503,allowed);
  const code=randomDigits(),form=new URLSearchParams({api_key:env.BULKSMSBD_API_KEY,type:"text",number:phone,senderid:env.BULKSMSBD_SENDER_ID,message:"Your Property Zone signup OTP is "+code+". It expires in 5 minutes. Do not share this code."});
  let gatewayResponse,gatewayText="";
  try{gatewayResponse=await fetch("https://bulksmsbd.net/api/smsapi",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form.toString()});gatewayText=(await gatewayResponse.text()).trim()}catch{return json({success:false,message:"Could not connect to SMS gateway. Please try again."},502,allowed)}
  if(!gatewayResponse.ok||!/(^|\D)202(\D|$)/.test(gatewayText)){console.error("BulkSMSBD rejected OTP request:",gatewayText.slice(0,160));return json({success:false,message:"SMS could not be sent. Check SMS gateway balance and sender ID."},502,allowed)}
  await env.OTP_STORE.put("otp:"+phone,JSON.stringify({codeHash:await hash(phone+":"+code),attempts:0,verified:false}),{expirationTtl:OTP_TTL_SECONDS});
  await env.OTP_STORE.put("cooldown:"+phone,"1",{expirationTtl:SEND_COOLDOWN_SECONDS});await env.OTP_STORE.put(dailyKey,String(sent+1),{expirationTtl:86400});
  return json({success:true,message:"OTP sent. Please check your phone."},200,allowed)
 }
 if(url.pathname==="/verify-otp"){
  const phone=normalizePhone(body.phone),code=String(body.code||"").trim();if(!phone||!/^\d{6}$/.test(code))return json({success:false,message:"Enter a valid phone number and 6-digit OTP."},400,allowed);
  const raw=await env.OTP_STORE.get("otp:"+phone);if(!raw)return json({success:false,message:"OTP expired. Please request a new code."},410,allowed);
  const rec=JSON.parse(raw);if(rec.verified&&rec.verificationToken)return json({success:true,verificationToken:rec.verificationToken},200,allowed);
  if(rec.attempts>=MAX_VERIFY_ATTEMPTS){await env.OTP_STORE.delete("otp:"+phone);return json({success:false,message:"Too many incorrect attempts. Request a new OTP."},429,allowed)}
  if(await hash(phone+":"+code)!==rec.codeHash){rec.attempts++;await env.OTP_STORE.put("otp:"+phone,JSON.stringify(rec),{expirationTtl:OTP_TTL_SECONDS});return json({success:false,message:"Incorrect OTP. Please check and try again."},400,allowed)}
  rec.verified=true;rec.verificationToken=randomToken();await env.OTP_STORE.put("otp:"+phone,JSON.stringify(rec),{expirationTtl:OTP_TTL_SECONDS});
  return json({success:true,verificationToken:rec.verificationToken,message:"Phone number verified."},200,allowed)
 }
 if(url.pathname==="/consume-otp"){
  const phone=normalizePhone(body.phone),token=String(body.verificationToken||"");if(!phone||!/^[a-f0-9]{64}$/.test(token))return json({success:false,message:"Invalid verification details."},400,allowed);
  if(await env.OTP_STORE.get("used:"+phone))return json({success:false,message:"This phone number has already been used."},409,allowed);
  const raw=await env.OTP_STORE.get("otp:"+phone);if(!raw)return json({success:false,message:"Verification expired. Please request a new OTP."},410,allowed);
  const rec=JSON.parse(raw);if(!rec.verified||rec.verificationToken!==token)return json({success:false,message:"Phone verification is not valid."},403,allowed);
  await env.OTP_STORE.put("used:"+phone,"1");await env.OTP_STORE.delete("otp:"+phone);return json({success:true,message:"Phone verification completed."},200,allowed)
 }
 return json({success:false,message:"Not found."},404,allowed)
}};
