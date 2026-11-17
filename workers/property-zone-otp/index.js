const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:cors});
const normalizePhone = (value) => {
  let p=String(value||"").replace(/[^0-9]/g,"");
  if(p.startsWith("01") && p.length===11) p="88"+p;
  if(p.startsWith("1") && p.length===10) p="880"+p;
  return /^8801[3-9][0-9]{8}$/.test(p) ? p : null;
};
async function one9(path, params, env) {
  if(!env.ONE9_API_KEY) throw new Error("SMS gateway is not configured");
  const body=new URLSearchParams({api_key:env.ONE9_API_KEY,...params});
  const res=await fetch("https://sms.one9.one/sms/api"+path,{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/x-www-form-urlencoded"},body});
  const raw=await res.text(); let data;
  try{data=JSON.parse(raw)}catch{data={message:raw}}
  if(!res.ok || data.success===false || data.status==="error" || data.error) throw new Error(data.message||data.error||"SMS gateway request failed");
  return data;
}
export default {
 async fetch(request, env) {
  const path=new URL(request.url).pathname.replace(/\\/+$/,"");
  if(request.method==="GET" && (path==="/" || path==="/health")) {
   return json({success:true,worker:"property-zone-otp",otpStorage:!!env.OTP_STORE,one9Configured:!!env.ONE9_API_KEY,firebaseConfigured:!!env.FIREBASE_SERVICE_ACCOUNT_JSON});
  }
  if(request.method==="OPTIONS") return new Response(null,{headers:cors});
  if(request.method!=="POST") return json({success:false,message:"Method not allowed"},405);
  if(!env.OTP_STORE) return json({success:false,message:"OTP storage is not configured"},500);
  let body; try{body=await request.json()}catch{return json({success:false,message:"Invalid JSON"},400)}
  const path=new URL(request.url).pathname.replace(/\/+$/,"");
  try {
   if(path.endsWith("/otp-send") || path.endsWith("/otp/send")) {
    const phone=normalizePhone(body.phone||body.to);
    if(!phone) return json({success:false,message:"Enter a valid Bangladesh phone number"},400);
    const key="otp-rate:"+phone, now=Date.now(), prior=await env.OTP_STORE.get(key,{type:"json"});
    if(prior && now-prior.last<60000) return json({success:false,message:"Please wait before requesting another OTP"},429);
    if(prior && prior.count>=5 && now-prior.window<86400000) return json({success:false,message:"Daily OTP limit reached"},429);
    const result=await one9("/otp/send",{to:phone,digits:"6",expiry:"5"},env);
    await env.OTP_STORE.put(key,JSON.stringify({last:now,window:prior?.window||now,count:(prior?.count||0)+1}),{expirationTtl:86400});
    return json({success:true,message:"OTP sent",gateway:result});
   }
   if(path.endsWith("/otp-verify") || path.endsWith("/otp/verify")) {
    const phone=normalizePhone(body.phone||body.to), otp=String(body.otp||"").trim();
    if(!phone || !/^\d{6}$/.test(otp)) return json({success:false,message:"Valid phone and 6-digit OTP are required"},400);
    const result=await one9("/otp/verify",{to:phone,otp},env);
    const token=crypto.randomUUID();
    await env.OTP_STORE.put("verified:"+token,phone,{expirationTtl:300});
    return json({success:true,verificationToken:token,phone, message:"OTP verified",gateway:result});
   }
   return json({success:false,message:"Unknown endpoint"},404);
  } catch(e) { return json({success:false,message:e.message||"OTP request failed"},502); }
 }
};