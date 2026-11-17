import {json,corsOrigin,preflight,readBody,normalizePhone,firebase,sha} from "./_shared.mjs";
export default async (req) => {
 const blocked=preflight(req); if(blocked)return blocked; const origin=corsOrigin(req);
 try {
  const body=await readBody(req),phone=normalizePhone(body?.phone),idToken=String(body?.idToken||""),verificationToken=String(body?.verificationToken||"");
  if(!phone||!idToken||!verificationToken)return json({success:false,message:"ফোন যাচাইয়ের তথ্য অসম্পূর্ণ।"},400,origin);
  const {auth,db}=firebase(),decoded=await auth.verifyIdToken(idToken),key=sha(phone),ref=db.collection("phoneOtpVerifications").doc(key);
  const snap=await ref.get(),v=snap.exists?snap.data():null;
  if(!v||v.phone!==phone||v.tokenHash!==sha(verificationToken)||v.expiresAt<Date.now())return json({success:false,message:"ফোন যাচাইয়ের মেয়াদ শেষ। আবার OTP নিন।"},403,origin);
  try { const existing=await auth.getUserByPhoneNumber(phone); if(existing.uid!==decoded.uid)return json({success:false,message:"এই নম্বর অন্য অ্যাকাউন্টে যুক্ত আছে।"},409,origin); }
  catch(e){if(e.code!=="auth/user-not-found")throw e;}
  await auth.updateUser(decoded.uid,{phoneNumber:phone});
  await db.collection("members").doc(decoded.uid).set({phoneNumber:phone,phoneVerified:true,updatedAt:Timestamp.now()},{merge:true});
  await ref.delete();
  return json({success:true,message:"ফোন নম্বর অ্যাকাউন্টে যুক্ত হয়েছে।"},200,origin);
 } catch(e){return json({success:false,message:e.message||"নিবন্ধন সম্পন্ন করা যায়নি।"},e.status||400,origin);}
};
import {Timestamp} from "firebase-admin/firestore";