// فحص مزودي المنتجات:  npm run test:products
// بيطبع حالة كل مزود (بدون ما يطبع التوكن).
const fs=require('fs'),path=require('path');
const f=path.join(__dirname,'..','.env');
for(const l of (fs.existsSync(f)?fs.readFileSync(f,'utf8'):'').split(/\r?\n/)){
  const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');
}
const E=k=>String(process.env[k]||'').trim();
const providers=[
  {name:'MEGA_GAME',url:()=>E('MEGA_GAME_API_BASE').replace(/\/$/,'')+'/api/fastapi/products',opts:()=>({headers:{apiToken:E('MEGA_GAME_API_TOKEN'),Accept:'application/json'}})},
  {name:'GIFT4CARD',url:()=>E('GIFT4CARD_API_BASE').replace(/\/$/,'')+(E('GIFT4CARD_PRODUCTS_PATH')||'/client/api/products'),opts:()=>({headers:{'api-token':E('GIFT4CARD_API_TOKEN'),Accept:'application/json'}})},
  {name:'SW_GAME',url:()=>E('SW_GAME_API_BASE').replace(/\/$/,'')+'/api/fastapi/products',opts:()=>({headers:{apiToken:E('SW_GAME_API_TOKEN'),Accept:'application/json'}})},
  {name:'FAST70',url:()=>E('FAST70_API_BASE').replace(/\/$/,''),opts:()=>({method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({key:E('FAST70_API_TOKEN'),action:'services'})})}
];
function count(d){const l=Array.isArray(d)?d:(d?.data?.products||d?.products||d?.services||d?.data);return Array.isArray(l)?l.length:null}
function hint(code,status,body){
  if(code==='ENOTFOUND')return 'الدومين غير موجود أو محجوب عندك (DNS). تأكد من رابط BASE أو جرّب شبكة/DNS ثاني (مثلاً 1.1.1.1).';
  if(/TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|UND_ERR/.test(String(code)))return 'الاتصال انقطع أو انحجب (شبكتك أو الـ VPN أو المزود بيحجب منطقتك).';
  if(status===401||status===403)return 'التوكن غلط أو IP جهازك غير مسموح عند المزود (whitelist).';
  if(status===404)return 'رابط BASE أو المسار غلط.';
  if(status===408)return 'المزود انتهت مهلته؛ جرّب مرة ثانية أو شبكة ثانية.';
  if(/<html|cloudflare|just a moment/i.test(body||''))return 'المزود رجّع صفحة حماية (Cloudflare)؛ الطلب من هالشبكة ممنوع.';
  return '';
}
(async()=>{
  for(const p of providers){
    const base=E(p.name+'_API_BASE'),tok=E(p.name+'_API_TOKEN');
    if(!base||!tok){console.log(`❌ ${p.name}: ناقص ${!base?p.name+'_API_BASE ':''}${!tok?p.name+'_API_TOKEN':''}`);continue}
    const t0=Date.now();
    try{
      const r=await fetch(p.url(),{redirect:'follow',signal:AbortSignal.timeout(25000),...p.opts()});
      const text=await r.text();let d;try{d=JSON.parse(text)}catch{}
      const n=d?count(d):null;const ms=Date.now()-t0;
      if(r.ok&&n!==null)console.log(`✅ ${p.name}: ${n} منتج (${ms}ms)`);
      else if(r.ok)console.log(`⚠️ ${p.name}: رد 200 لكن بدون قائمة منتجات. بداية الرد: ${text.slice(0,160).replace(/\s+/g,' ')}`);
      else console.log(`❌ ${p.name}: HTTP ${r.status} (${ms}ms) ${hint('',r.status,text)}\n   بداية الرد: ${text.slice(0,160).replace(/\s+/g,' ')}`);
    }catch(e){const code=e.cause?.code||e.name;console.log(`❌ ${p.name}: ${code} — ${e.message} ${hint(code)}`)}
  }
})();
