const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ADMIN = path.join(ROOT, 'admin');
const PORT = Number(process.env.PORT || 3000);
const sessions = new Map();
const devices = new Map();
const config = new Map();

function loadEnv(){
  const f=path.join(ROOT,'.env'); if(!fs.existsSync(f)) return;
  for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){
    const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if(m && !process.env[m[1]]) process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');
  }
}
loadEnv();

const USERS={
  main:{username:process.env.ADMIN_USERNAME||'yhya',password:process.env.ADMIN_PASSWORD||'',role:'main'},
  support:{username:process.env.SUPPORT_USERNAME||'support',password:process.env.SUPPORT_PASSWORD||'',role:'support'}
};
const MAX_SUPPORT_DEVICES=Number(process.env.SUPPORT_MAX_DEVICES||2);
const store=require('./lib/store');
const createAdmin=require('./lib/admin');
const admin=createAdmin({
  USERS,json:(res,st,d)=>json(res,st,d),env:(n,f)=>env(n,f),supaAdmin:(...a)=>supaAdmin(...a),
  liveCatalog:(f)=>liveCatalog(f),executeOrder:(item,fields,qty,uuid)=>item.source==='fast70'?executeFast70(item,fields,qty):executeGameOrder(item,fields,qty,uuid),
  cleanName:(v)=>cleanName(v),publicDir:PUBLIC,maxSupportDevices:MAX_SUPPORT_DEVICES,productStatus:()=>PRODUCT_STATUS
});
function forcedRequired(){const v=store.get().settings.forcedChannels.required;return v===null||v===undefined?String(process.env.FORCED_CHANNELS_REQUIRED||'false').toLowerCase()==='true':!!v}
async function getAuthUser(req){
  const bearer=String(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i)?.[1];
  const base=env('SUPABASE_URL').replace(/\/$/,''),anon=env('SUPABASE_ANON_KEY')||env('SUPABASE_PUBLISHABLE_KEY');
  if(!bearer)return {error:'سجّل الدخول أولاً',status:401};
  if(!base||!anon)return {error:'إعداد Supabase غير مكتمل على الخادم',status:503};
  try{
    const r=await fetch(`${base}/auth/v1/user`,{headers:{apikey:anon,Authorization:`Bearer ${bearer}`},signal:AbortSignal.timeout(15000)});
    if(!r.ok)return {error:'جلسة الدخول منتهية، سجّل الدخول من جديد',status:401};
    const u=await r.json();
    if(!u?.id)return {error:'تعذر تحديد الحساب',status:401};
    if(u.banned_until&&new Date(u.banned_until)>new Date())return {error:'هذا الحساب موقوف',status:403};
    return {user:u};
  }catch{return {error:'تعذر الاتصال بخدمة الحسابات',status:503}}
}


function env(name, fallback=''){ return String(process.env[name] ?? fallback); }
function sha256(v){ return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function randomCode(){ return String(crypto.randomInt(100000,1000000)); }
function escapeHtml(v){ return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function supaAdmin(pathname, options={}){
  const base=env('SUPABASE_URL').replace(/\/$/,''); const key=env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
  if(!base||!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY غير مضبوط في .env');
  const headers=Object.assign({'apikey':key,'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},options.headers||{});
  return fetch(`${base}${pathname}`,Object.assign({},options,{headers}));
}
// ================= Gmail SMTP (بدون مكتبات خارجية) =================
function mimeWord(s){s=String(s);return /^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${Buffer.from(s,'utf8').toString('base64')}?=`}
function b64(s){return Buffer.from(String(s),'utf8').toString('base64')}
function wrap76(s){return (s.match(/.{1,76}/g)||['']).join('\r\n')}
function smtpOpen(host,port){
  return new Promise((resolve,reject)=>{
    const socket=require('tls').connect({host,port,servername:host});
    socket.setTimeout(20000,()=>socket.destroy(new Error('SMTP timeout')));
    let buf='',err=null,waiter=null;
    const pump=()=>{
      if(!waiter)return;
      const lines=buf.split('\r\n');
      for(let i=0;i<lines.length-1;i++){
        if(/^\d{3}(?: |$)/.test(lines[i])){
          const reply=lines.slice(0,i+1).join('\r\n');buf=lines.slice(i+1).join('\r\n');
          const w=waiter;waiter=null;return w.resolve(reply);
        }
      }
      if(err){const w=waiter;waiter=null;w.reject(err)}
    };
    socket.on('data',c=>{buf+=c.toString('utf8');pump()});
    socket.on('error',e=>{err=e;pump()});
    socket.on('close',()=>{err=err||new Error('SMTP connection closed');pump()});
    const read=()=>new Promise((res,rej)=>{waiter={resolve:res,reject:rej};pump()});
    const cmd=async(line,ok)=>{socket.write(line+'\r\n');const r=await read();const code=Number(r.slice(0,3));if(!ok.includes(code))throw new Error(`SMTP ${code}: ${r.replace(/\r?\n/g,' | ').slice(0,200)}`);return r};
    socket.once('secureConnect',()=>resolve({socket,read,cmd}));
    socket.once('error',reject);
  });
}
async function sendGmailEmail({to,subject,text,html}){
  const host=env('GMAIL_SMTP_HOST','smtp.gmail.com'),port=Number(env('GMAIL_SMTP_PORT','465'));
  const user=env('GMAIL_SMTP_USER')||env('GMAIL_USER'),pass=(env('GMAIL_SMTP_APP_PASSWORD')||env('GMAIL_APP_PASSWORD')).replace(/\s+/g,'');
  const from=env('GMAIL_FROM_EMAIL',user),name=env('GMAIL_FROM_NAME','QASION CARD');
  if(!user||!pass)throw new Error('GMAIL_SMTP_USER أو GMAIL_SMTP_APP_PASSWORD غير مضبوطين في .env');
  if(!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(to))throw new Error('عنوان بريد غير صالح');
  const {socket,read,cmd}=await smtpOpen(host,port);
  try{
    const greet=await read();if(!greet.startsWith('220'))throw new Error('SMTP greeting: '+greet.slice(0,120));
    await cmd('EHLO qasioncard.local',[250]);
    await cmd('AUTH LOGIN',[334]);await cmd(b64(user),[334]);
    try{await cmd(b64(pass),[235])}catch(e){if(/SMTP 535/.test(e.message))throw new Error('رفض Gmail بيانات الدخول (535): تأكد من App Password المكوّن من 16 حرفاً وأن التحقق بخطوتين مفعّل');throw e}
    await cmd(`MAIL FROM:<${from}>`,[250]);await cmd(`RCPT TO:<${to}>`,[250,251]);await cmd('DATA',[354]);
    const boundary='qc_'+crypto.randomBytes(12).toString('hex'),domain=from.split('@')[1]||'qasioncard.local';
    const headers=[`From: ${mimeWord(name)} <${from}>`,`To: <${to}>`,`Subject: ${mimeWord(subject)}`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${crypto.randomUUID()}@${domain}>`,'MIME-Version: 1.0',`Content-Type: multipart/alternative; boundary="${boundary}"`];
    const part=(type,content)=>`--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(content))}\r\n`;
    const msg=headers.join('\r\n')+'\r\n\r\n'+part('text/plain',text)+part('text/html',html)+`--${boundary}--\r\n`;
    await cmd(msg+'.',[250]);
    try{await cmd('QUIT',[221])}catch{}
  }finally{socket.destroy()}
}

async function tsaRequest(params={}, options={}){
  const base=env('TSA_API_BASE','https://tsa-api.com/api/v1').replace(/\/$/,'');
  const key=env('TSA_API_KEY');
  if(!key) throw new Error('TSA_API_KEY غير مضبوط في .env');
  const qs=new URLSearchParams(params);
  const url=`${base}?${qs.toString()}`;
  const headers={Accept:'application/json','X-Api-Key':key,...(options.headers||{})};
  const r=await fetch(url,{...options,headers});
  const text=await r.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{data={success:false,error:'استجابة TSA غير صالحة'}}
  if(!r.ok||data.success===false) { const e=new Error(data.error||`TSA HTTP ${r.status}`); e.status=r.status; e.data=data; throw e; }
  return data;
}
async function tsaAccounts(){return tsaRequest({resource:'accounts',action:'list'});}
async function tsaFindIncoming(provider, tx){
  const accounts=await tsaAccounts();
  if(provider==='shamcash'){
    const a=accounts?.data?.shamcash?.find(x=>x.account_address)||accounts?.data?.shamcash?.[0];
    if(!a?.account_address) throw new Error('لا يوجد حساب Sham Cash مرتبط في TSA');
    return tsaRequest({resource:'shamcash',action:'find_tx',tx:String(tx),account_address:a.account_address});
  }
  if(provider==='syriatel'){
    const a=accounts?.data?.syriatel?.find(x=>x.is_primary)||accounts?.data?.syriatel?.[0];
    if(!a?.gsm) throw new Error('لا يوجد خط Syriatel Cash مرتبط في TSA');
    return tsaRequest({resource:'syriatel',action:'find_tx',tx:String(tx),gsm:a.gsm});
  }
  throw new Error('طريقة دفع غير مدعومة');
}
async function supaRpc(name, body){
  const r=await supaAdmin(`/rest/v1/rpc/${name}`,{method:'POST',body:JSON.stringify(body||{})});
  const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{}}catch{}
  if(!r.ok) throw new Error(d?.message||d?.hint||d?.details||'فشل تنفيذ العملية المالية');
  return d;
}

// ================= CAPTCHA + Rate limit + OTP =================
const CAPTCHAS=new Map(),TICKETS=new Map(),RL=new Map(),COOL=new Map();
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OTP_PURPOSES=['signup','login','recovery'];
const enc=encodeURIComponent;
function normEmail(v){return String(v||'').trim().toLowerCase().slice(0,254)}
function clientIp(req){return String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket.remoteAddress||'unknown'}
function rateLimit(key,max,ms){const now=Date.now();let r=RL.get(key);if(!r||r.reset<=now){r={n:0,reset:now+ms};RL.set(key,r)}r.n++;return r.n<=max}
function coolLeft(key){return Math.max(0,Math.ceil(((COOL.get(key)||0)-Date.now())/1000))}
function coolSet(key,ms){COOL.set(key,Date.now()+ms)}
function issueTicket(email,purpose){const t=crypto.randomBytes(24).toString('hex');TICKETS.set(t,{email,purpose,uses:0,expires:Date.now()+15*60000});return t}
setInterval(()=>{const now=Date.now();for(const[k,v]of RL)if(v.reset<=now)RL.delete(k);for(const[k,v]of COOL)if(v<=now)COOL.delete(k);for(const[k,v]of CAPTCHAS)if(v.expires<=now)CAPTCHAS.delete(k);for(const[k,v]of TICKETS)if(v.expires<=now)TICKETS.delete(k)},60000).unref();

async function verifyTurnstile(token,ip){
  const secret=env('TURNSTILE_SECRET_KEY');
  if(!secret)return {ok:true,mode:'math'};
  if(!token)return {ok:false,message:'أكمل اختبار الأمان أولاً'};
  try{const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret,response:String(token),remoteip:ip||''})});const d=await r.json();return {ok:!!d.success,mode:'turnstile',message:d.success?'':'فشل اختبار الأمان، حاول مرة أخرى'}}catch{return {ok:false,message:'تعذر التحقق من اختبار الأمان حالياً'}}
}
function turnstileEnabled(){return !!(env('TURNSTILE_SECRET_KEY')&&env('TURNSTILE_SITE_KEY'))}
function captchaIssue(){
  if(turnstileEnabled())return {turnstile:true};
  const id=crypto.randomBytes(16).toString('hex'),op=['+','-','×'][crypto.randomInt(0,3)];
  let a=crypto.randomInt(2,10),b=crypto.randomInt(2,10);if(op==='-'&&b>a)[a,b]=[b,a];
  const v=op==='+'?a+b:op==='-'?a-b:a*b;
  if(CAPTCHAS.size>5000)CAPTCHAS.delete(CAPTCHAS.keys().next().value);
  CAPTCHAS.set(id,{answer:sha256(`${v}:${id}`),expires:Date.now()+5*60000});
  return {id,question:`${a} ${op} ${b} = ؟`,turnstile:false};
}
async function captchaCheck(body,req){
  if(turnstileEnabled())return verifyTurnstile(body.turnstileToken,clientIp(req));
  const id=String(body.captchaId||''),answer=String(body.captchaAnswer||'').trim().replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const c=CAPTCHAS.get(id);CAPTCHAS.delete(id);
  if(!c||c.expires<Date.now()||sha256(`${answer}:${id}`)!==c.answer)return {ok:false,message:'إجابة اختبار الأمان غير صحيحة أو منتهية'};
  return {ok:true,mode:'math'};
}

async function findUserByEmail(email){
  const target=normEmail(email);
  try{
    const r=await supaAdmin('/rest/v1/rpc/qc_get_user_by_email',{method:'POST',body:JSON.stringify({p_email:target})});
    if(r.ok){const d=await r.json();const row=Array.isArray(d)?d[0]:d;return row&&row.id?row:null}
  }catch{}
  for(let page=1;page<=20;page++){
    const r=await supaAdmin(`/auth/v1/admin/users?page=${page}&per_page=100`);if(!r.ok)return null;
    const d=await r.json();const users=d?.users||[];const hit=users.find(x=>normEmail(x.email)===target);if(hit)return hit;if(users.length<100)break;
  }
  return null;
}
function otpHash(email,purpose,code){
  const secret=env('OTP_SECRET')||env('SUPABASE_SECRET_KEY')||env('SUPABASE_SERVICE_ROLE_KEY');
  return crypto.createHmac('sha256',secret).update(`${normEmail(email)}|${purpose}|${code}`).digest('hex');
}
function safeEq(a,b){const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
const OTP_TEXT={signup:['تأكيد إنشاء حسابك','رمز تأكيد البريد'],login:['تسجيل الدخول إلى حسابك','رمز الدخول'],recovery:['استعادة كلمة المرور','رمز استعادة كلمة المرور']};
async function issueOtp(email,purpose){
  email=normEmail(email);
  const code=randomCode(),mins=Math.max(3,Number(env('OTP_EXPIRES_MINUTES','10')));
  await supaAdmin(`/rest/v1/qc_email_otps?email=eq.${enc(email)}&purpose=eq.${enc(purpose)}&used_at=is.null`,{method:'DELETE'});
  const ins=await supaAdmin('/rest/v1/qc_email_otps',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({email,purpose,code_hash:otpHash(email,purpose,code),expires_at:new Date(Date.now()+mins*60000).toISOString()})});
  if(!ins.ok)throw new Error('تعذر حفظ رمز التحقق في Supabase — هل شغّلت supabase_custom_auth.sql؟ ('+ins.status+')');
  const [title,label]=OTP_TEXT[purpose]||OTP_TEXT.login;
  await sendGmailEmail({to:email,subject:`${code} — ${label} QASION CARD`,
    text:`QASION CARD\n${title}\n\n${label}: ${code}\nينتهي الرمز خلال ${mins} دقائق.\nإذا لم تطلب هذا الرمز فتجاهل الرسالة ولا تشاركه مع أحد.`,
    html:`<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#06111d;color:#fff;padding:28px;border-radius:16px;max-width:480px;margin:auto"><h2 style="margin:0 0 6px;color:#20dcff">QASION CARD</h2><p style="margin:0 0 18px;color:#a8bdd1">${title}</p><p>${label}:</p><div dir="ltr" style="font-size:36px;font-weight:900;letter-spacing:10px;color:#20dcff;background:#03111e;border:1px solid #0b6f9f;border-radius:12px;padding:14px;text-align:center">${code}</div><p style="color:#a8bdd1">ينتهي الرمز خلال ${mins} دقائق.</p><p style="color:#ffd66b;font-size:13px">لا تشارك هذا الرمز مع أي شخص. فريق QASION CARD لن يطلبه منك أبداً.</p></div>`});
}
async function consumeOtp(email,purpose,code){
  email=normEmail(email);const now=new Date().toISOString();
  const r=await supaAdmin(`/rest/v1/qc_email_otps?email=eq.${enc(email)}&purpose=eq.${enc(purpose)}&used_at=is.null&expires_at=gt.${enc(now)}&select=id,attempts,code_hash&order=created_at.desc&limit=1`);
  const rows=await r.json().catch(()=>[]);if(!r.ok||!Array.isArray(rows)||!rows.length)return null;
  const row=rows[0],max=Number(env('OTP_MAX_ATTEMPTS','5')),attempts=Number(row.attempts)||0;if(attempts>=max)return null;
  if(!safeEq(row.code_hash,otpHash(email,purpose,code))){
    const burn=attempts+1>=max;
    await supaAdmin(`/rest/v1/qc_email_otps?id=eq.${row.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(burn?{attempts:attempts+1,used_at:now}:{attempts:attempts+1})});
    return null;
  }
  const u=await supaAdmin(`/rest/v1/qc_email_otps?id=eq.${row.id}&used_at=is.null`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({used_at:now})});
  const upd=await u.json().catch(()=>[]);return(u.ok&&Array.isArray(upd)&&upd.length)?row.id:null;
}
async function confirmEmail(user){
  if(user.email_confirmed_at)return;
  await supaAdmin(`/auth/v1/admin/users/${user.id}`,{method:'PUT',body:JSON.stringify({email_confirm:true})});
  try{await supaAdmin(`/rest/v1/profiles?id=eq.${user.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({email_verified:true})})}catch{}
}

function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body)}
function readBody(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>2e6) reject(new Error('body too large'))});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch{resolve({})}});req.on('error',reject)})}
function token(){return crypto.randomBytes(32).toString('hex')}
function auth(req){return admin.getSession(req)}

const PRODUCT_CACHE={items:[],at:0};
const PRODUCT_TTL=Number(process.env.PRODUCT_CACHE_TTL_MS||300000);
function envBool(k,d=false){const v=String(process.env[k]??'').toLowerCase();return v?['1','true','yes','on'].includes(v):d;}
function cleanName(v){return String(v||'').trim().toLowerCase().replace(/[{}()[\]_-]+/g,' ').replace(/\s+/g,' ');}
function gameCategory(name){const n=cleanName(name); if(/instagram|telegram|tiktok|youtube|facebook|twitter|x \b|followers|likes|views|members|social/.test(n)) return 'social'; return 'game';}
function normalizeDynamicFields(fields){return Array.isArray(fields)?fields.map(f=>({name:String(f.name||f.key||''),type:String(f.type||'text'),label:f.label||f.name||f.key||'',placeholder:f.placeholder||'',help_text:f.help_text||'',required:f.required!==false,options:Array.isArray(f.options)?f.options:[]})).filter(f=>f.name):[]}
function normalizeFastGameProduct(p,source){
  const name=String(p.name||p.title||'').trim(); if(!name)return null;
  const price=Number(p.price); if(!Number.isFinite(price))return null;
  const active=p.isActive===undefined?true:Boolean(Number(p.isActive)); if(!active)return null;
  const game=String(p.gameName||p.game_name||name).trim();
  return {external_id:String(p.id),source,provider:source,name,gameName:game,category:gameCategory(game),price,currency:String(p.currency||'USD').toUpperCase(),selling_price:price*(1+Number(process.env.PROFIT_MARGIN||0.03)),image:p.image||'',note:p.note||'',minCount:Number(p.minCount||1),maxCount:Number(p.maxCount||1),dynamicFields:normalizeDynamicFields(p.daynamicFields||p.dynamicFields),raw:p};
}
async function providerFetch(url,opts={}){
  const tries=Number(process.env.PROVIDER_RETRIES||2),timeout=Number(process.env.PROVIDER_TIMEOUT_MS||20000);let lastErr;
  for(let i=0;i<=tries;i++){
    try{
      const r=await fetch(url,{redirect:'follow',signal:AbortSignal.timeout(timeout),...opts});
      const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
      if(!r.ok){const e=new Error(`Provider HTTP ${r.status}`);e.retry=[408,425,429,500,502,503,504].includes(r.status);throw e}
      return data;
    }catch(e){lastErr=e;const net=!e.message.startsWith('Provider HTTP');if(i<tries&&(net||e.retry)){await new Promise(ok=>setTimeout(ok,1500*(i+1)));continue}break}
  }
  throw lastErr;
}
async function fetchFastGameCatalog(source){
  const base=String(process.env[`${source.toUpperCase()}_API_BASE`]||'').replace(/\/$/,'');
  const token=process.env[`${source.toUpperCase()}_API_TOKEN`];
  if(!base||!token)return [];
  const data=await providerFetch(`${base}/api/fastapi/products`,{headers:{apiToken:token,Accept:'application/json'}});
  const list=Array.isArray(data?.data?.products)?data.data.products:(Array.isArray(data?.products)?data.products:[]);
  return list.map(p=>normalizeFastGameProduct(p,source)).filter(Boolean);
}
async function fetchGiftCatalog(){
  const base=String(process.env.GIFT4CARD_API_BASE||'').replace(/\/$/,''); const token=process.env.GIFT4CARD_API_TOKEN;
  if(!base||!token)return [];
  const data=await providerFetch(base+(process.env.GIFT4CARD_PRODUCTS_PATH||'/client/api/products'),{headers:{'api-token':token,Accept:'application/json'}});
  const list=Array.isArray(data?.data?.products)?data.data.products:(Array.isArray(data?.products)?data.products:(Array.isArray(data?.data)?data.data:[]));
  return list.map((p,i)=>{const name=String(p.name||p.title||p.product_name||'').trim();const price=Number(p.price??p.sell_price??p.cost);if(!name||!Number.isFinite(price))return null;return {external_id:String(p.id??p.product_id??i),source:'gift4card',provider:'gift4card',name,gameName:String(p.gameName||p.game_name||name),category:'game',price,currency:String(p.currency||'USD').toUpperCase(),selling_price:price*(1+Number(process.env.PROFIT_MARGIN||0.03)),image:p.image||p.image_url||'',note:p.note||'',minCount:Number(p.minCount||p.min||1),maxCount:Number(p.maxCount||p.max||1),dynamicFields:normalizeDynamicFields(p.dynamicFields||p.daynamicFields||p.fields),raw:p};}).filter(Boolean);
}
async function fetchFast70Catalog(){
  const base=String(process.env.FAST70_API_BASE||'').replace(/\/$/,''); const token=process.env.FAST70_API_TOKEN; if(!base||!token)return [];
  const data=await providerFetch(base,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({key:token,action:'services'})});
  const list=Array.isArray(data)?data:(Array.isArray(data?.services)?data.services:[]);
  return list.map(p=>{const name=String(p.name||'').trim();const price=Number(p.rate);if(!name||!Number.isFinite(price))return null;return {external_id:String(p.service),source:'fast70',provider:'fast70',name,gameName:name,category:'social',subcategory:String(p.category||''),price,currency:'USD',selling_price:price*(1+Number(process.env.PROFIT_MARGIN||0.03)),image:'',note:`الحد ${p.min||1} - ${p.max||''}`,minCount:Number(p.min||1),maxCount:Number(p.max||1),dynamicFields:[{name:'link',type:'url',label:'الرابط',placeholder:'ضع الرابط',required:true}],raw:p};}).filter(Boolean);
}
function mergeCatalog(all){
  const map=new Map();
  for(const p of all){
    const key=`${p.category}|${cleanName(p.name)}`;
    const existing=map.get(key);
    if(!existing){map.set(key,{...p,providers:[{source:p.source,external_id:p.external_id,price:p.price,selling_price:p.selling_price,currency:p.currency,dynamicFields:p.dynamicFields,minCount:p.minCount,maxCount:p.maxCount,note:p.note,image:p.image,raw:p.raw}]});}
    else {existing.providers.push({source:p.source,external_id:p.external_id,price:p.price,selling_price:p.selling_price,currency:p.currency,dynamicFields:p.dynamicFields,minCount:p.minCount,maxCount:p.maxCount,note:p.note,image:p.image,raw:p.raw}); if(p.price<existing.price){existing.price=p.price;existing.selling_price=p.selling_price;existing.currency=p.currency;existing.source=p.source;existing.external_id=p.external_id;existing.dynamicFields=p.dynamicFields;existing.image=p.image;existing.note=p.note;}}
  }
  return [...map.values()].map((p,i)=>({...p,id:`${p.source}-${p.external_id}-${i}`,serverCount:p.providers.length,providers:p.providers.map((x,i)=>({...x,server:`server ${i+1}`}))}));
}
const CACHE_FILE=path.join(__dirname,'data','products-cache.json');
const PRODUCT_STATUS={at:0,providers:[],servedFrom:'none'};
function loadDiskCache(){try{const d=JSON.parse(fs.readFileSync(CACHE_FILE,'utf8'));if(Array.isArray(d.items)&&d.items.length){PRODUCT_CACHE.items=d.items;PRODUCT_CACHE.at=Number(d.at)||0;PRODUCT_STATUS.servedFrom='disk-cache';return true}}catch{}return false}
function saveDiskCache(){try{fs.mkdirSync(path.dirname(CACHE_FILE),{recursive:true});fs.writeFileSync(CACHE_FILE,JSON.stringify({at:PRODUCT_CACHE.at,items:PRODUCT_CACHE.items}))}catch{}}
loadDiskCache();
async function liveCatalog(force=false){
  if(!force&&PRODUCT_CACHE.items.length&&Date.now()-PRODUCT_CACHE.at<PRODUCT_TTL)return PRODUCT_CACHE.items;
  const defs=[['mega_game','MEGA_GAME',()=>fetchFastGameCatalog('mega_game')],['gift4card','GIFT4CARD',()=>fetchGiftCatalog()],['sw_game','SW_GAME',()=>fetchFastGameCatalog('sw_game')],['fast70','FAST70',()=>fetchFast70Catalog()]];
  const all=[],providers=[];
  for(const [name,envp,fn] of defs){
    const configured=!!(process.env[envp+'_API_BASE']&&process.env[envp+'_API_TOKEN']);
    if(!configured){providers.push({name,configured:false,ok:false,count:0,error:'ناقص '+envp+'_API_TOKEN أو '+envp+'_API_BASE في .env'});continue}
    try{const list=await fn();all.push(...list);providers.push({name,configured:true,ok:true,count:list.length})}
    catch(e){console.warn('catalog provider failed:',name,e.message);providers.push({name,configured:true,ok:false,count:0,error:e.message})}
  }
  PRODUCT_STATUS.at=Date.now();PRODUCT_STATUS.providers=providers;
  const merged=mergeCatalog(all);
  if(merged.length){PRODUCT_CACHE.items=merged;PRODUCT_CACHE.at=Date.now();PRODUCT_STATUS.servedFrom='live';saveDiskCache();return merged}
  if(PRODUCT_CACHE.items.length){PRODUCT_STATUS.servedFrom=PRODUCT_STATUS.servedFrom==='live'?'memory-cache':PRODUCT_STATUS.servedFrom;return PRODUCT_CACHE.items}
  PRODUCT_STATUS.servedFrom='none';return merged;
}
function providerItem(product,server){return (product.providers||[]).find(x=>x.server===server)||product.providers?.[0];}
async function executeGameOrder(item,fields,qty,uuid){const source=item.source;if(source==='gift4card')throw new Error('GIFT4CARD_ORDER_NOT_CONFIGURED');const base=String(process.env[`${source.toUpperCase()}_API_BASE`]||'').replace(/\/$/,'');const token=process.env[`${source.toUpperCase()}_API_TOKEN`];if(!base||!token)throw new Error('PROVIDER_NOT_CONFIGURED');const params=new URLSearchParams({qty:String(qty),uuid:String(uuid)});for(const [k,v] of Object.entries(fields||{}))params.set(k,String(v));return providerFetch(`${base}/api/fastapi/requestorder/${encodeURIComponent(item.external_id)}/params?${params.toString()}`,{headers:{apiToken:token,Accept:'application/json'}})}
async function executeFast70(item,fields,qty){const token=process.env.FAST70_API_TOKEN;if(!token)throw new Error('PROVIDER_NOT_CONFIGURED');return providerFetch(process.env.FAST70_API_BASE,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({key:token,action:'add',service:item.external_id,link:String(fields?.link||''),quantity:Number(qty)})});}


// ================= مسارات المصادقة =================
async function authApi(req,res,u){
  const p=u.pathname,POST=req.method==='POST',ip=clientIp(req);
  const tooMany=(msg='محاولات كثيرة، انتظر قليلاً ثم حاول مرة أخرى')=>json(res,429,{ok:false,message:msg});

  if(p==='/api/auth/captcha'&&req.method==='GET'){
    if(!rateLimit('cap:'+ip,60,10*60000))return tooMany();
    json(res,200,captchaIssue());return true;
  }

  if(p==='/api/auth/signup'&&POST){
    if(!rateLimit('signup:'+ip,10,3600000)){tooMany();return true}
    const b=await readBody(req);
    const email=normEmail(b.email),password=String(b.password||''),full_name=String(b.full_name||'').trim().slice(0,80),country=String(b.country||'').trim().slice(0,60),phone=String(b.phone||'').trim().slice(0,25),age=Number(b.age);
    if(!EMAIL_RE.test(email)||password.length<8||password.length>72||full_name.length<2||!country||!/^\+?[0-9\s\-()]{6,20}$/.test(phone)||!Number.isInteger(age)||age<13||age>120){
      json(res,400,{ok:false,message:'أكمل بيانات الحساب بشكل صحيح (كلمة المرور من 8 إلى 72 حرفاً)'});return true}
    const cap=await captchaCheck(b,req);if(!cap.ok){json(res,400,{ok:false,message:cap.message});return true}
    let user=await findUserByEmail(email),created=false;
    if(user&&user.email_confirmed_at){json(res,409,{ok:false,code:'exists',message:'هذا البريد مسجّل مسبقاً. سجّل الدخول أو استعد كلمة المرور.'});return true}
    const key='otp:signup:'+email;
    if(coolLeft(key)>0){json(res,429,{ok:false,retryAfter:coolLeft(key),message:`انتظر ${coolLeft(key)} ثانية قبل طلب رمز جديد`});return true}
    if(!user){
      const cr=await supaAdmin('/auth/v1/admin/users',{method:'POST',body:JSON.stringify({email,password,email_confirm:false,user_metadata:{full_name,country,phone,age}})});
      const d=await cr.json().catch(()=>({}));
      if(!cr.ok){const code=d?.error_code||d?.code;json(res,code==='email_exists'?409:400,{ok:false,message:code==='weak_password'?'كلمة المرور ضعيفة، اختر كلمة أقوى':(d?.msg||d?.message||'تعذر إنشاء الحساب')});return true}
      user=d;created=true;
      try{await supaAdmin(`/rest/v1/profiles?id=eq.${user.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({full_name,country,phone,age,email_verified:false})})}catch{}
    }
    try{await issueOtp(email,'signup')}catch(e){
      console.error('[auth] signup mail failed:',e.message);
      if(created)await supaAdmin(`/auth/v1/admin/users/${user.id}`,{method:'DELETE'}).catch(()=>{});
      json(res,502,{ok:false,message:'تعذر إرسال رمز التحقق إلى بريدك الآن. حاول لاحقاً.'});return true}
    coolSet(key,60000);
    json(res,200,{ok:true,resumed:!created,retryAfter:60,resendTicket:issueTicket(email,'signup'),message:created?'تم إنشاء الحساب. أرسلنا رمز التحقق إلى بريدك.':'هذا البريد مسجّل ولم يُفعَّل بعد. أرسلنا رمزاً جديداً.'});
    return true;
  }

  if(p==='/api/auth/send-otp'&&POST){
    if(!rateLimit('otp-ip:'+ip,20,3600000)){tooMany();return true}
    const b=await readBody(req),email=normEmail(b.email),purpose=String(b.purpose||'');
    if(!EMAIL_RE.test(email)||!OTP_PURPOSES.includes(purpose)){json(res,400,{ok:false,message:'بيانات غير صحيحة'});return true}
    const t=b.resendTicket?TICKETS.get(String(b.resendTicket)):null;
    if(t&&t.email===email&&t.purpose===purpose&&t.expires>Date.now()&&t.uses<3){t.uses++}
    else{const cap=await captchaCheck(b,req);if(!cap.ok){json(res,400,{ok:false,message:cap.message});return true}}
    if(!rateLimit(`otp-em:${purpose}:${email}`,6,3600000)){tooMany();return true}
    const key=`otp:${purpose}:${email}`;
    if(coolLeft(key)>0){json(res,429,{ok:false,retryAfter:coolLeft(key),message:`انتظر ${coolLeft(key)} ثانية قبل إعادة الإرسال`});return true}
    coolSet(key,60000);
    const generic={ok:true,retryAfter:60,resendTicket:issueTicket(email,purpose),message:'إذا كان البريد مسجلاً لدينا فقد أرسلنا إليه رمز التحقق.'};
    const user=await findUserByEmail(email).catch(()=>null);
    const eligible=user&&(purpose==='signup'?!user.email_confirmed_at:purpose==='login'?!!user.email_confirmed_at:true);
    if(!eligible){json(res,200,generic);return true}
    try{await issueOtp(email,purpose)}catch(e){console.error('[auth] send-otp failed:',e.message);COOL.delete(key);json(res,502,{ok:false,message:'تعذر إرسال البريد الآن. حاول لاحقاً.'});return true}
    json(res,200,generic);return true;
  }

  if(p==='/api/auth/verify-otp'&&POST){
    if(!rateLimit('vf-ip:'+ip,40,15*60000)){tooMany();return true}
    const b=await readBody(req),email=normEmail(b.email),purpose=String(b.purpose||''),code=String(b.code||'').trim();
    if(!EMAIL_RE.test(email)||!OTP_PURPOSES.includes(purpose)||!/^\d{6}$/.test(code)){json(res,400,{ok:false,message:'رمز التحقق يجب أن يكون 6 أرقام'});return true}
    if(!rateLimit(`vf-em:${purpose}:${email}`,12,15*60000)){tooMany();return true}
    const bad=()=>json(res,400,{ok:false,message:'رمز التحقق غير صحيح أو منتهي'});
    if(!await consumeOtp(email,purpose,code)){bad();return true}
    const user=await findUserByEmail(email);if(!user){bad();return true}
    await confirmEmail(user);
    if(purpose==='login'){
      const gl=await supaAdmin('/auth/v1/admin/generate_link',{method:'POST',body:JSON.stringify({type:'magiclink',email})});
      const d=await gl.json().catch(()=>({})),th=d?.hashed_token||d?.properties?.hashed_token;
      if(!gl.ok||!th){console.error('[auth] generate_link failed',gl.status,JSON.stringify(d).slice(0,200));json(res,502,{ok:false,message:'تعذر إنشاء جلسة الدخول. حاول لاحقاً.'});return true}
      json(res,200,{ok:true,tokenHash:th});return true;
    }
    if(purpose==='recovery'){
      const raw=crypto.randomBytes(32).toString('hex');
      await supaAdmin('/rest/v1/qc_recovery_tokens',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:user.id,token_hash:sha256(raw),expires_at:new Date(Date.now()+15*60000).toISOString()})});
      json(res,200,{ok:true,recoveryToken:raw,message:'تم التحقق. عيّن كلمة المرور الجديدة.'});return true;
    }
    json(res,200,{ok:true,message:'تم تأكيد البريد بنجاح.'});return true;
  }

  if(p==='/api/auth/reset-password'&&POST){
    if(!rateLimit('rst:'+ip,10,3600000)){tooMany();return true}
    const b=await readBody(req),raw=String(b.recoveryToken||''),password=String(b.password||'');
    if(raw.length<40||password.length<8||password.length>72){json(res,400,{ok:false,message:'كلمة المرور يجب أن تكون من 8 إلى 72 حرفاً'});return true}
    const th=sha256(raw);
    const r=await supaAdmin(`/rest/v1/qc_recovery_tokens?token_hash=eq.${th}&used_at=is.null&expires_at=gt.${enc(new Date().toISOString())}&select=id,user_id&limit=1`);
    const rows=await r.json().catch(()=>[]);
    if(!r.ok||!Array.isArray(rows)||!rows.length){json(res,400,{ok:false,message:'انتهت صلاحية الاستعادة، ابدأ من جديد'});return true}
    const claim=await supaAdmin(`/rest/v1/qc_recovery_tokens?id=eq.${rows[0].id}&used_at=is.null`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({used_at:new Date().toISOString()})});
    const cl=await claim.json().catch(()=>[]);if(!claim.ok||!Array.isArray(cl)||!cl.length){json(res,400,{ok:false,message:'انتهت صلاحية الاستعادة، ابدأ من جديد'});return true}
    const up=await supaAdmin(`/auth/v1/admin/users/${rows[0].user_id}`,{method:'PUT',body:JSON.stringify({password})});
    if(!up.ok){const d=await up.json().catch(()=>({}));json(res,400,{ok:false,message:d?.error_code==='weak_password'?'كلمة المرور ضعيفة، اختر كلمة أقوى':'تعذر تغيير كلمة المرور'});return true}
    json(res,200,{ok:true,message:'تم تغيير كلمة المرور بنجاح.'});return true;
  }
  return false;
}
function authSelfCheck(){
  const miss=[];
  if(!env('SUPABASE_URL'))miss.push('SUPABASE_URL');
  if(!(env('SUPABASE_SECRET_KEY')||env('SUPABASE_SERVICE_ROLE_KEY')))miss.push('SUPABASE_SECRET_KEY');
  if(!(env('SUPABASE_PUBLISHABLE_KEY')||env('SUPABASE_ANON_KEY')))miss.push('SUPABASE_PUBLISHABLE_KEY');
  if(!(env('GMAIL_SMTP_APP_PASSWORD')||env('GMAIL_APP_PASSWORD')))miss.push('GMAIL_SMTP_APP_PASSWORD');
  if(miss.length)console.warn('⚠️  إعدادات ناقصة في .env — تسجيل الدخول/OTP لن يعمل حتى تضبطها:',miss.join(', '));
  else console.log('✅ إعدادات Supabase وGmail موجودة (شغّل npm run test:mail لاختبار الإرسال)');
}

async function api(req,res,u){
  if(store.get().settings.maintenance.enabled&&!['/api/site','/api/public-config','/api/forced-channels'].includes(u.pathname)&&!u.pathname.startsWith('/api/auth/')&&!u.pathname.startsWith('/api/admin/')&&!u.pathname.startsWith('/api/tsa/admin-action'))
    return json(res,503,{ok:false,maintenance:true,message:store.get().settings.maintenance.message});
  if(u.pathname.startsWith('/api/auth/')){
    try{if(await authApi(req,res,u)!==false)return}catch(e){console.error('[auth]',e.message);return json(res,500,{ok:false,message:'خطأ في الخادم أثناء المصادقة. راجع سجلات الخادم.'})}
    return json(res,404,{ok:false,message:'not found'});
  }


  if(u.pathname==='/api/tsa/status' && req.method==='GET'){
    try{const d=await tsaRequest({resource:'status'});return json(res,200,{ok:true,provider:'TSA',status:d})}catch(e){return json(res,e.status===401?401:502,{ok:false,message:e.message})}
  }
  if(u.pathname==='/api/tsa/accounts' && req.method==='GET'){
    try{const d=await tsaAccounts();const accounts=d?.data||{};return json(res,200,{ok:true,shamcash:accounts.shamcash||[],syriatel:accounts.syriatel||[]})}catch(e){return json(res,e.status===401?401:502,{ok:false,message:e.message})}
  }

  if(u.pathname==='/api/products' && req.method==='GET'){
    return json(res,200,{products:admin.publicProducts(),servers:{game:['server 1','server 2','server 3'],social:[]}});
  }
  if(u.pathname==='/api/site' && req.method==='GET')return json(res,200,admin.publicSettings());
  if(u.pathname==='/api/provider/order' && req.method==='POST'){
    const au=await getAuthUser(req); if(au.error)return json(res,au.status,{ok:false,message:au.error});
    const body=await readBody(req);
    const r=await admin.createOrder({user:au.user,productId:String(body.productId||''),server:String(body.server||''),quantity:body.quantity,fields:body.fields&&typeof body.fields==='object'?body.fields:{}});
    if(!r.ok)return json(res,r.status||400,{ok:false,message:r.message});
    return json(res,200,{ok:true,orderId:r.order.id,status:r.order.status,order:admin.publicOrder(r.order)});
  }
  if(u.pathname==='/api/payment-methods' && req.method==='GET') return json(res,200,{methods:[
    {id:'sham-usd',name:'Sham Cash',provider:'shamcash',currency:'USD',label:'دولار أمريكي',img:'SHAM',mode:'auto'},
    {id:'sham-syp',name:'Sham Cash',provider:'shamcash',currency:'SYP',label:'ليرة سورية',img:'SHAM',mode:'auto'},
    {id:'sham-eur',name:'Sham Cash',provider:'shamcash',currency:'EUR',label:'يورو',img:'SHAM',mode:'auto'},
    {id:'syriatel',name:'Syriatel Cash',provider:'syriatel',currency:'SYP',label:'ليرة سورية',img:'SYRIATEL',mode:'auto'},
    {id:'binance',name:'Binance',provider:'manual',currency:'USDT',label:'USDT / Binance',img:'BINANCE',mode:'manual'},
    {id:'kazawallet',name:'KazaWallet',provider:'manual',currency:'USD',label:'KazaWallet',img:'KAZA',mode:'manual'},
    {id:'usdt',name:'USDT',provider:'manual',currency:'USDT',label:'USDT',img:'USDT',mode:'manual'}
  ]});
  if(u.pathname==='/api/forced-channels' && req.method==='GET'){
    const required=forcedRequired();
    const telegram={name:'Telegram',target:env('FORCED_TELEGRAM_CHANNEL','@GameChargeSyriaBot49'),url:env('FORCED_TELEGRAM_URL','https://t.me/GameChargeSyriaBot49'),verification:'telegram'};
    const youtube={name:'YouTube',target:env('FORCED_YOUTUBE_CHANNEL','@QASIONCARDSSYRIA'),url:env('FORCED_YOUTUBE_URL','https://www.youtube.com/@QASIONCARDSSYRIA'),verification:'optional'};
    const whatsapp={name:'WhatsApp',target:'',url:env('FORCED_WHATSAPP_URL','https://whatsapp.com/channel/0029Vb8u4ZnFy72GGAmwHJ1s'),verification:'optional'};
    return json(res,200,{required,channels:[telegram,youtube,whatsapp]});
  }
  if(u.pathname==='/api/telegram/channels' && req.method==='GET'){
    const required=forcedRequired();
    const channels=String(process.env.FORCED_CHANNELS||'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>{const [name,raw]=x.split('|');const target=(raw||name||'').trim();const url=/^https?:\/\//i.test(target)?target:(/^@/.test(target)?`https://t.me/${target.slice(1)}`:target);return {name:(name||target).trim(),url}});
    return json(res,200,{required:required&&channels.length>0,channels});
  }
  if(u.pathname==='/api/public-config' && req.method==='GET'){return json(res,200,{supabaseUrl:process.env.SUPABASE_URL||'',supabaseAnonKey:process.env.SUPABASE_PUBLISHABLE_KEY||process.env.SUPABASE_ANON_KEY||'',turnstileSiteKey:turnstileEnabled()?env('TURNSTILE_SITE_KEY'):''})}
  if(u.pathname==='/api/telegram/link' && req.method==='POST'){
    const authHeader=String(req.headers.authorization||'');
    const bearer=authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
    if(!bearer)return json(res,401,{ok:false,message:'جلسة QASION CARD غير موجودة'});
    const b=await readBody(req);
    const token=process.env.TELEGRAM_BOT_TOKEN;
    const supabaseUrl=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');
    const anonKey=process.env.SUPABASE_ANON_KEY;
    if(!token)return json(res,503,{ok:false,message:'TELEGRAM_BOT_TOKEN غير مضبوط في .env'});
    if(!supabaseUrl||!anonKey)return json(res,503,{ok:false,message:'إعداد Supabase غير مكتمل في .env'});
    const required=['id','auth_date','hash'];
    if(required.some(k=>b[k]===undefined||b[k]===null||String(b[k]).trim()===''))return json(res,400,{ok:false,message:'بيانات Telegram ناقصة'});
    try{
      const authDate=Number(b.auth_date);
      if(!Number.isFinite(authDate)||Math.floor(Date.now()/1000)-authDate>600||authDate-Math.floor(Date.now()/1000)>60)return json(res,400,{ok:false,message:'جلسة Telegram منتهية أو غير صالحة'});
      const fields=Object.keys(b).filter(k=>k!=='hash'&&b[k]!==undefined&&b[k]!==null).sort();
      const checkString=fields.map(k=>`${k}=${b[k]}`).join('\n');
      const secret=crypto.createHash('sha256').update(token).digest();
      const expected=crypto.createHmac('sha256',secret).update(checkString).digest('hex');
      const provided=String(b.hash);
      const a=Buffer.from(expected,'hex'),bb=Buffer.from(provided,'hex');
      if(a.length!==bb.length||!crypto.timingSafeEqual(a,bb))return json(res,401,{ok:false,message:'تعذر التحقق من توقيع Telegram'});

      const userResp=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{apikey:anonKey,Authorization:`Bearer ${bearer}`} });
      if(!userResp.ok)return json(res,401,{ok:false,message:'جلسة Supabase غير صالحة أو منتهية'});
      const authUser=await userResp.json();
      if(!authUser?.id)return json(res,401,{ok:false,message:'تعذر تحديد حساب QASION CARD'});

      const payload={user_id:authUser.id,telegram_id:String(b.id),username:b.username||null,first_name:b.first_name||null,last_name:b.last_name||null,photo_url:b.photo_url||null,linked_at:new Date().toISOString()};
      const linkResp=await fetch(`${supabaseUrl}/rest/v1/qc_telegram_links?on_conflict=user_id`,{method:'POST',headers:{apikey:anonKey,Authorization:`Bearer ${bearer}`,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=representation'},body:JSON.stringify(payload)});
      const linkText=await linkResp.text();
      if(!linkResp.ok){
        let msg='تعذر حفظ ربط Telegram في قاعدة البيانات';
        try{const e=JSON.parse(linkText);if(e?.message)msg=e.message;else if(e?.hint)msg=e.hint}catch{}
        if(linkResp.status===409)msg='حساب Telegram هذا مرتبط بحساب QASION CARD آخر';
        return json(res,linkResp.status,{ok:false,message:msg});
      }
      return json(res,200,{ok:true,telegram:{id:String(b.id),username:b.username||null,first_name:b.first_name||null}});
    }catch(e){return json(res,502,{ok:false,message:'تعذر إكمال التحقق من Telegram حالياً'})}
  }
  if(u.pathname==='/api/tsa/verify-deposit' && req.method==='POST'){
    const authHeader=String(req.headers.authorization||'');
    const bearer=authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
    if(!bearer)return json(res,401,{ok:false,message:'سجّل الدخول أولاً'});
    const supabaseUrl=String(process.env.SUPABASE_URL||'').replace(/\/$/,''); const anonKey=process.env.SUPABASE_ANON_KEY;
    if(!supabaseUrl||!anonKey)return json(res,503,{ok:false,message:'إعداد Supabase غير مكتمل'});
    const ur=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{apikey:anonKey,Authorization:`Bearer ${bearer}`}});
    if(!ur.ok)return json(res,401,{ok:false,message:'جلسة الدخول منتهية'});
    const authUser=await ur.json(); if(!authUser?.id)return json(res,401,{ok:false,message:'تعذر تحديد الحساب'});
    const b=await readBody(req);
    const provider=String(b.provider||'').toLowerCase(); const tx=String(b.transaction||'').trim(); const expectedAmount=Number(b.amount); const expectedCurrency=String(b.currency||'').toUpperCase();
    if(!['shamcash','syriatel'].includes(provider)||!tx||!Number.isFinite(expectedAmount)||expectedAmount<=0)return json(res,400,{ok:false,message:'بيانات الإيداع غير صحيحة'});
    if(provider==='shamcash'&&!['USD','SYP','EUR'].includes(expectedCurrency))return json(res,400,{ok:false,message:'Sham Cash يدعم USD / SYP / EUR فقط'});
    if(provider==='syriatel'&&expectedCurrency!=='SYP')return json(res,400,{ok:false,message:'Syriatel Cash للإيداع هنا هو SYP فقط'});
    try{const d=await tsaFindIncoming(provider,tx);const found=d?.data?.found===true;const t=d?.data?.transaction||{};if(!found)return json(res,200,{ok:false,status:'not_found',message:'لم نجد حوالة واردة ناجحة بهذا الرقم بعد.'});const status=provider==='syriatel'?String(t.status)==='1':String(t.direction||'incoming')==='incoming';const amount=Number(t.amount);const currency=String(t.currency||'SYP').toUpperCase();if(!status)return json(res,200,{ok:false,status:'not_incoming',message:'العملية موجودة لكنها ليست حوالة واردة ناجحة.'});if(Math.abs(amount-expectedAmount)>0.000001||currency!==expectedCurrency)return json(res,200,{ok:false,status:'mismatch',message:`الحوالة موجودة لكن المبلغ/العملة لا تطابق الطلب. الوارد: ${amount} ${currency}`});const credited=await supaRpc('qc_credit_wallet',{p_user_id:authUser.id,p_amount:amount,p_currency:currency,p_reference:tx,p_provider:provider});return json(res,200,{ok:true,status:'credited',transaction:t,credit:credited,message:'تم التحقق من الحوالة وإضافة الرصيد تلقائياً.'});}catch(e){return json(res,e.status===429?429:502,{ok:false,status:'error',message:e.message})}
  }
  const s=auth(req);
  if(u.pathname==='/api/tsa/admin-action' && req.method==='POST'){
    if(!s)return json(res,401,{ok:false,message:'سجّل دخول الإدارة أولاً'});if(s.role!=='main')return json(res,403,{ok:false,message:'هذه العملية المالية للإدارة الرئيسية فقط'});
    const b=await readBody(req); const action=String(b.action||'');
    try{
      if(action==='sham_balance'){const d=await tsaRequest({resource:'shamcash',action:'balance',account_address:String(b.account_address||'')});return json(res,200,d)}
      if(action==='sham_logs'){const d=await tsaRequest({resource:'shamcash',action:'logs',account_address:String(b.account_address||'')});return json(res,200,d)}
      if(action==='sham_outgoing'){const d=await tsaRequest({resource:'shamcash',action:'outgoing_logs',account_address:String(b.account_address||'')});return json(res,200,d)}
      if(action==='sham_find'){const d=await tsaRequest({resource:'shamcash',action:'find_tx',tx:String(b.tx||''),account_address:String(b.account_address||'')});return json(res,200,d)}
      if(action==='sham_resolve'){const d=await tsaRequest({resource:'shamcash',action:'resolve',account_address:String(b.account_address||''),to_address:String(b.to_address||'')});return json(res,200,d)}
      if(action==='sham_transfer'){const d=await tsaRequest({resource:'shamcash',action:'transfer',account_address:String(b.account_address||'')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to_address:String(b.to_address||''),amount:String(b.amount||''),currency:String(b.currency||'SYP'),note:String(b.note||''),pin:String(b.pin||'')})});return json(res,200,d)}
      if(action==='sy_balance'){const d=await tsaRequest({resource:'syriatel',action:'balance',gsm:String(b.gsm||'')});return json(res,200,d)}
      if(action==='sy_history'){const d=await tsaRequest({resource:'syriatel',action:'history',gsm:String(b.gsm||''),period:String(b.period||'7')});return json(res,200,d)}
      if(action==='sy_outgoing'){const d=await tsaRequest({resource:'syriatel',action:'outgoing_history',gsm:String(b.gsm||''),period:String(b.period||'30')});return json(res,200,d)}
      if(action==='sy_find'){const d=await tsaRequest({resource:'syriatel',action:'find_tx',gsm:String(b.gsm||''),tx:String(b.tx||'')});return json(res,200,d)}
      if(action==='sy_transfer'){const d=await tsaRequest({resource:'syriatel',action:'transfer_cash'},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gsm:String(b.gsm||''),to_gsm:String(b.to_gsm||''),amount:String(b.amount||''),pin_code:String(b.pin_code||'')})});return json(res,200,d)}
      if(action==='sy_recharge'){const d=await tsaRequest({resource:'syriatel',action:'mobile_recharge'},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({gsm:String(b.gsm||''),to_gsm:String(b.to_gsm||''),amount:String(b.amount||''),pin_code:String(b.pin_code||'')})});return json(res,200,d)}
      return json(res,400,{ok:false,message:'عملية TSA غير معروفة'});
    }catch(e){return json(res,e.status===429?429:502,{ok:false,message:e.message})}
  }
  if(u.pathname==='/api/rates'){
    const base=u.searchParams.get('base')||'USD';const api=process.env.EXCHANGE_RATE_API_URL;
    if(!api)return json(res,503,{error:'EXCHANGE_RATE_API_URL غير مضبوط'});
    try{const target=new URL(api);target.searchParams.set('base',base);const r=await fetch(target,{headers:process.env.EXCHANGE_RATE_API_KEY?{'Authorization':`Bearer ${process.env.EXCHANGE_RATE_API_KEY}`}:{}});const d=await r.json();const rates=d.rates||d.conversion_rates||{};return json(res,r.ok?200:502,{base,rates,updatedAt:d.time_last_update_utc||d.updated_at||new Date().toISOString()})}catch(e){return json(res,502,{error:'تعذر جلب سعر الصرف'})}
  }
  if(u.pathname==='/api/telegram/verify' && req.method==='POST'){
    const authHeader=String(req.headers.authorization||'');
    const bearer=authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
    if(!bearer)return json(res,401,{ok:false,message:'سجّل الدخول أولاً'});
    const token=env('TELEGRAM_BOT_TOKEN');
    if(!token)return json(res,503,{ok:false,message:'TELEGRAM_BOT_TOKEN غير مضبوط في .env'});
    const supabaseUrl=env('SUPABASE_URL').replace(/\/$/,''); const anonKey=env('SUPABASE_ANON_KEY');
    if(!supabaseUrl||!anonKey)return json(res,503,{ok:false,message:'إعداد Supabase غير مكتمل'});
    try{
      const ur=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{apikey:anonKey,Authorization:`Bearer ${bearer}`}});
      if(!ur.ok)return json(res,401,{ok:false,message:'جلسة الدخول منتهية'});
      const authUser=await ur.json(); if(!authUser?.id)return json(res,401,{ok:false,message:'تعذر تحديد الحساب'});
      const lr=await supaAdmin(`/rest/v1/qc_telegram_links?user_id=eq.${encodeURIComponent(authUser.id)}&select=telegram_id&limit=1`);
      const links=await lr.json(); const id=String(links?.[0]?.telegram_id||'');
      if(!id)return json(res,200,{ok:false,telegramLinked:false,message:'اربط Telegram أولاً من قسم الحماية.'});
      const chat=env('FORCED_TELEGRAM_CHANNEL','@GameChargeSyriaBot49');
      const r=await fetch(`https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${encodeURIComponent(id)}`);
      const d=await r.json();
      if(!r.ok||!d?.ok)return json(res,502,{ok:false,message:'تعذر التحقق من عضوية Telegram حالياً.'});
      const st=d?.result?.status;
      const joined=['creator','administrator','member'].includes(st) || (st==='restricted' && d?.result?.is_member===true);
      if(!joined)return json(res,200,{ok:false,telegramLinked:true,message:'لم يتم الاشتراك في قناة Telegram المطلوبة بعد.'});
      return json(res,200,{ok:true,telegramLinked:true});
    }catch{return json(res,502,{ok:false,message:'تعذر الاتصال بTelegram حالياً.'})}
  }
  return json(res,404,{error:'API route not found'});
}
function serveFile(req,res,file){try{const stat=fs.statSync(file);if(!stat.isFile())throw 0;const ext=path.extname(file).toLowerCase();const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};const headers={'Content-Type':types[ext]||'application/octet-stream'}; if(['.svg','.js','.css','.png','.jpg','.jpeg','.webp','.ico'].includes(ext)) headers['Cache-Control']='public, max-age=86400, stale-while-revalidate=604800'; res.writeHead(200,headers);fs.createReadStream(file).pipe(res)}catch{json(res,404,{error:'not found'})}}
const server=http.createServer(async(req,res)=>{try{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Cross-Origin-Opener-Policy','same-origin-allow-popups');res.setHeader('X-Permitted-Cross-Domain-Policies','none');if(req.headers['x-forwarded-proto']==='https'||process.env.NODE_ENV==='production')res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(u.pathname.startsWith('/api/')){if(await admin.handle(req,res,u))return;return api(req,res,u)}if(u.pathname==='/admin'||u.pathname==='/admin/')return serveFile(req,res,path.join(ADMIN,'index.html'));const spaRoutes=new Set(['/','/services','/deposit','/payments','/wallet','/orders','/agents','/security','/levels','/verification','/about','/privacy','/terms','/api-info','/support','/transfer','/other-payments']);let p=spaRoutes.has(u.pathname)?'/index.html':u.pathname;let file=path.normalize(path.join(PUBLIC,p));if(!file.startsWith(PUBLIC))return json(res,403,{error:'forbidden'});return serveFile(req,res,file)}catch(e){json(res,500,{error:'server error'})}});
if(require.main===module)server.listen(PORT,()=>{authSelfCheck();console.log(`QASION CARD running: http://localhost:${PORT}`);console.log(`لوحة الإدارة: http://localhost:${PORT}/admin/`);if(!USERS.main.password)console.warn('⚠️  ADMIN_PASSWORD غير مضبوط في .env — لن تستطيع دخول لوحة الإدارة');const mins=Number(process.env.PRODUCT_AUTO_SYNC_MINUTES||0);if(mins>0)setInterval(()=>admin.syncFromProviders().then(r=>{if(r.error)console.warn('auto sync:',r.error)}).catch(e=>console.warn('auto sync failed:',e.message)),mins*60000)});
module.exports={sendGmailEmail,server};
