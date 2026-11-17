import {json,corsOrigin,preflight,readBody,normalizePhone,firebase} from "./_shared.mjs";
export default async (req) => {
 const blocked=preflight(req); if(blocked)return blocked; const origin=corsOrigin(req);
 try {
  const body=await readBody(req),phone=normalizePhone(body?.phone),password=String(body?.password||"");
  if(!phone||!password)return json({success:false,message:"মোবাইল নম্বর ও পাসওয়ার্ড দিন।"},400,origin);
  if(password.length>128)return json({success:false,message:"Login failed."},400,origin);
  const {auth}=firebase(),user=await auth.getUserByPhoneNumber(phone);
  if(!user.email)return json({success:false,message:"এই অ্যাকাউন্টে ইমেইল লগইন তথ্য নেই।"},400,origin);
  const apiKey=process.env.FIREBASE_WEB_API_KEY;
  if(!apiKey)throw new Error("Firebase Web API key is not configured.");
  const response=await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key="+encodeURIComponent(apiKey),{
   method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:user.email,password,returnSecureToken:true})
  });
  if(!response.ok)return json({success:false,message:"মোবাইল নম্বর অথবা পাসওয়ার্ড সঠিক নয়।"},401,origin);
  const result=await response.json(),decoded=await auth.verifyIdToken(result.idToken);
  if(decoded.uid!==user.uid)return json({success:false,message:"Login failed."},401,origin);
  const customToken=await auth.createCustomToken(user.uid);
  return json({success:true,customToken},200,origin);
 } catch(e){return json({success:false,message:e.code==="auth/user-not-found"?"এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি।":(e.message||"Login failed.")},e.status||401,origin);}
};