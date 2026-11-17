import { corsOrigin, preflight, json, readBody, firebase } from "./_shared.mjs";
import { randomInt } from "node:crypto";

const ADMIN_ACCOUNTS = new Map([
  ["Ry06huUzzmeqryzna9lPzpNw4Rr1", "ridoyhasank5434@gmail.com"],
  ["bSOdvUtNO4Vxl3lJBuFA2xiREP53", "prologisinvest@gmail.com"]
]);

async function requireUser(req, auth) {
  const match = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/i);
  if (!match) throw Object.assign(new Error("Please sign in first."), { status: 401 });
  try { return await auth.verifyIdToken(match[1]); }
  catch { throw Object.assign(new Error("Your login session expired."), { status: 401 }); }
}
async function requireAdmin(user, db) {
  if (ADMIN_ACCOUNTS.get(user.uid) !== user.email || user.email_verified !== true)
    throw Object.assign(new Error("Unauthorized administrator."), { status: 403 });
  const snap = await db.doc("admins/" + user.uid).get();
  if (!snap.exists || snap.data().role !== "admin" || snap.data().active !== true)
    throw Object.assign(new Error("Admin permission is not active."), { status: 403 });
}

export default async (req) => {
  const blocked = preflight(req);
  if (blocked) return blocked;
  const origin = corsOrigin(req);
  try {
    const body = await readBody(req);
    if (!body || typeof body.action !== "string") return json({success:false,message:"Invalid request."},400,origin);
    const {auth,db} = firebase();
    const user = await requireUser(req,auth);

    if (body.action === "admin-claims") {
      await requireAdmin(user,db);
      const sref = db.doc("siteSettings/mysteryBox");
      const ss = await sref.get();
      const settings = ss.exists ? ss.data() : {};
      const roundId = String(settings.roundId || "");
      if (!roundId) return json({success:true,roundId:"",claims:[],remaining:0,total:0,claimedCount:0},200,origin);
      const snap = await db.collection("mysteryBoxRounds").doc(roundId).collection("claims").orderBy("createdAt","desc").limit(100).get();
      const claims = snap.docs.map(d => {
        const x=d.data();
        return {id:d.id,uid:x.uid||"",email:x.email||"",name:x.name||"Member",publicId:x.publicId||"",rewardAmount:Number(x.rewardAmount)||0,status:x.status||"recorded",createdAt:x.createdAt?.toDate?.().toISOString?.()||null};
      });
      return json({success:true,roundId,claims,remaining:Array.isArray(settings.prizePoolRemaining)?settings.prizePoolRemaining.length:0,total:Array.isArray(settings.prizePool)?settings.prizePool.length:0,claimedCount:Number(settings.claimedCount)||0,prizePoolTotalBDT:Number(settings.prizePoolTotalBDT)||0,enabled:settings.enabled===true},200,origin);
    }

    if (body.action !== "claim") return json({success:false,message:"Unknown action."},400,origin);
    const memberSnap = await db.doc("members/"+user.uid).get();
    if (!memberSnap.exists || ["blocked","suspended"].includes(memberSnap.data().status))
      return json({success:false,message:"An active member account is required."},403,origin);
    const member = memberSnap.data();
    const settingsRef = db.doc("siteSettings/mysteryBox");
    const result = await db.runTransaction(async tx => {
      const ss = await tx.get(settingsRef);
      if (!ss.exists) throw Object.assign(new Error("Mystery Box is not configured."),{status:404});
      const s=ss.data();
      if (s.enabled !== true) throw Object.assign(new Error("Mystery Box is closed."),{status:403});
      const roundId=String(s.roundId||"");
      if (!roundId) throw Object.assign(new Error("No active prize round."),{status:409});
      const claimRef=db.collection("mysteryBoxRounds").doc(roundId).collection("claims").doc(user.uid);
      const old=await tx.get(claimRef);
      if (old.exists) return {alreadyClaimed:true,rewardAmount:Number(old.data().rewardAmount)||0,roundId};
      const remaining=Array.isArray(s.prizePoolRemaining)?[...s.prizePoolRemaining]:[];
      if (!remaining.length) throw Object.assign(new Error("All prizes in this round have been claimed."),{status:409});
      const limit=Math.max(0,Math.floor(Number(s.claimLimit)||0));
      const count=Math.max(0,Math.floor(Number(s.claimedCount)||0));
      if (limit>0 && count>=limit) throw Object.assign(new Error("This round has reached its claim limit."),{status:409});
      const amount=Number(remaining.splice(randomInt(remaining.length),1)[0]);
      if (!Number.isSafeInteger(amount)||amount<1) throw Object.assign(new Error("Invalid prize pool entry."),{status:500});
      tx.update(settingsRef,{prizePoolRemaining:remaining,claimedCount:count+1,lastClaimAt:new Date()});
      tx.create(claimRef,{uid:user.uid,email:user.email||"",name:String(member.name||user.name||"Member").slice(0,100),publicId:String(member.publicId||""),rewardAmount:amount,roundId,status:"recorded",createdAt:new Date()});
      return {alreadyClaimed:false,rewardAmount:amount,roundId,remainingCount:remaining.length};
    });
    return json({success:true,...result,walletCredited:false,message:result.alreadyClaimed?"You already opened this box in this round.":"Your reward has been recorded."},200,origin);
  } catch (e) {
    const status=Number(e.status)||500;
    if(status>=500) console.error("Mystery Box claim error:",e);
    return json({success:false,message:status===500?"Mystery Box is temporarily unavailable.":(e.message||"Request failed.")},status,origin);
  }
};