import {json,corsOrigin,preflight,readBody,normalizePhone,firebase,one9,sha,token} from "./_shared.mjs";
export default async (req) => {
 const blocked=preflight(req); if(blocked)return blocked; const origin=corsOrigin(req);
 try {
  const body=await readBody(req),phone=normalizePhone(body?.phone),otp=String(body?.otp||"").trim();
  if(!phone||!/^\d{6}$/.test(otp))return json({success:false,message:"৬ সংখ্যার OTP দিন।"},400,origin);
  await one9("/otp/verify",{to:phone,otp});
  const {db}=firebase(),verificationToken=token(),key=sha(phone);
  await db.collection("phoneOtpVerifications").doc(key).set({phone,tokenHash:sha(verificationToken),verifiedAt:Date.now(),expiresAt:Date.now()+5*60*1000});
  return json({success:true,verificationToken,message:"ফোন নম্বর যাচাই হয়েছে।"},200,origin);
 } catch(e){return json({success:false,message:e.message||"OTP যাচাই করা যায়নি।"},e.status||400,origin);}
};