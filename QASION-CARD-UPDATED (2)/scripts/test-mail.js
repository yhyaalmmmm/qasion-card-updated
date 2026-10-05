// اختبار إرسال Gmail الحقيقي:  npm run test:mail -- you@example.com
const fs=require('fs'),path=require('path');
for(const l of (fs.existsSync(path.join(__dirname,'..','.env'))?fs.readFileSync(path.join(__dirname,'..','.env'),'utf8'):'').split(/\r?\n/)){
  const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
}
const {sendGmailEmail}=require('../server.js');
const to=process.argv[2]||process.env.GMAIL_SMTP_USER;
const code=String(Math.floor(100000+Math.random()*900000));
sendGmailEmail({to,subject:`${code} — اختبار QASION CARD`,text:`رمز الاختبار: ${code}`,html:`<div dir="rtl"><h2>QASION CARD</h2><p>رمز الاختبار: <b style="font-size:26px;letter-spacing:6px">${code}</b></p></div>`})
  .then(()=>{console.log('✅ تم الإرسال إلى',to,'— تحقق من الوارد/السبام');process.exit(0)})
  .catch(e=>{console.error('❌ فشل الإرسال:',e.message);process.exit(1)});
