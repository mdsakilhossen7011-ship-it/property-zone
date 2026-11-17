import {json,corsOrigin,preflight,readBody,normalizePhone,firebase,one9} from "./_shared.mjs";
export default async (req) => {
 const blocked=preflight(req); if(blocked)return blocked; const origin=corsOrigin(req);
 try {
  const body=await readBody(req), phone=normalizePhone(body?.phone);
  if(!phone)return json({success:false,message:"সঠিক বাংলাদেশি মোবাইল নম্বর দিন।"},400,origin);
  const {auth,db}=firebase();
  try { await auth.getUserByPhoneNumber(phone); return json({success:false,message:"এই নম্বর দিয়ে আগে থেকেই অ্যাকাউন্ট আছে।"},409,origin); }
  catch(e){ if(e.code!=="auth/user-not-found") throw e; }
  const ref=db.collection("phoneOtpRateLimits").doc(phone.replace(/\D/g,""));
  const now=Date.now();
  await db.runTransaction(async tx=>{
   const snap=await tx.get(ref), v=snap.exists?snap.data():{};
   if(v.cooldownUntil && v.cooldownUntil.toMillis()>now) { const e=new Error("একটু অপেক্ষা করে আবার OTP চান।"); e.status=429; throw e; }
   const day=new Date().toISOString().slice(0,10), count=v.day===day?(v.count||0):0;
   if(count>=5){const e=new Error("আজ এই নম্বরে OTP পাঠানোর সীমা শেষ।");e.status=429;throw e;}
   tx.set(ref,{day,count:count+1,cooldownUntil:Timestamp.fromMillis(now+60000),updatedAt:Timestamp.now()},{merge:true});
  });
  try {
   await one9("/otp/send",{to:phone,digits:"6",expiry:"5"});
  } catch(gatewayError) {
   console.error("OTP gateway send failed:",gatewayError?.message||gatewayError);
   return json({success:false,message:"এই মুহূর্তে OTP সার্ভিস সাময়িকভাবে অনুপলব্ধ। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন"},502,origin);
  }
  return json({success:true,message:"OTP পাঠানো হয়েছে।"},200,origin);
 } catch(e){ return json({success:false,message:e.message||"OTP পাঠানো যায়নি।"},e.status||502,origin); }
};