# QASION CARD — إعداد تسجيل الدخول وOTP عبر Gmail

## كيف يعمل النظام
- **الحسابات والجلسات**: Supabase Auth (المتصفح يسجّل الدخول مباشرة بكلمة المرور).
- **رمز OTP (6 أرقام)**: يولّده خادمك `server.js` ويرسله عبر Gmail SMTP — ولا يمر عبر SMTP الخاص بـ Supabase.
- الرموز تُخزَّن كـ **HMAC** (وليس نصاً) في `qc_email_otps`، صالحة 10 دقائق، 5 محاولات كحد أقصى، ولا تُستخدم إلا مرة واحدة.
- مسارات الواجهة:
  1. **حساب جديد** ← بيانات + اختبار أمان ← رمز على البريد ← تأكيد ← دخول تلقائي.
  2. **دخول بكلمة المرور** (مباشر عبر Supabase).
  3. **دخول برمز البريد** (بدون كلمة مرور).
  4. **نسيت كلمة المرور** ← رمز ← كلمة جديدة.

## الخطوات (مرة واحدة)

### 1) Gmail App Password
1. فعّل **التحقق بخطوتين** على حساب Gmail المرسِل.
2. افتح https://myaccount.google.com/apppasswords وأنشئ كلمة مرور تطبيق (16 حرفاً).

### 2) ملف `.env`
انسخ `.env.example` إلى `.env` واملأ على الأقل:
```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_PUBLISHABLE_KEY=...        # المفتاح العام (anon/publishable)
SUPABASE_SECRET_KEY=...             # service_role — للخادم فقط
GMAIL_SMTP_USER=noreply.qasioncard@gmail.com
GMAIL_SMTP_APP_PASSWORD=abcdefghijklmnop
GMAIL_FROM_EMAIL=noreply.qasioncard@gmail.com
OTP_SECRET=اكتب_نصاً_عشوائياً_طويلاً      # اختياري لكن يُنصح به
```

### 3) قاعدة البيانات
في Supabase → SQL Editor شغّل **`supabase_custom_auth.sql`** (جداول OTP + دالة `qc_get_user_by_email`).
ثم `supabase_auth_security.sql` إن لم تكن شغّلته.

### 4) إعدادات Supabase Dashboard (مهم)
- Authentication → Providers → **Email = Enabled**.
- Authentication → Attack Protection → **أطفئ CAPTCHA الخاص بـ Supabase**؛ لأن الواجهة تسجّل الدخول بكلمة المرور مباشرة بدون توكن Supabase-CAPTCHA (وإلا سيفشل الدخول). الحماية تتم عندك عبر CAPTCHA/Turnstile الخاص بالموقع على مسارات OTP والتسجيل والاستعادة.
- لا تحتاج تفعيل "Confirm email": الخادم يؤكد البريد بعد نجاح الرمز.

### 5) اختبر الإرسال قبل تشغيل الموقع
```bash
npm run test:mail -- بريدك@example.com
```
إن وصلك الرمز فـ Gmail جاهز. رسائل الخطأ تشرح السبب (مثلاً 535 = App Password خطأ).

### 6) شغّل
```bash
npm run dev
```
وعند الإقلاع سيطبع الخادم تحذيراً بأي متغير ناقص.

## Cloudflare Turnstile (اختياري، موصى به للإنتاج)
ضع `TURNSTILE_SITE_KEY` و`TURNSTILE_SECRET_KEY` فيتحول الاختبار الحسابي تلقائياً إلى Turnstile.

## ملاحظات أمان ونشر
- الخادم **Node طويل العمر** (حالة الـ CAPTCHA والـ rate-limit في الذاكرة): انشره على Render/Railway/VPS — وليس كـ Serverless Functions على Vercel.
- لا ترفع `.env` لـ GitHub. إن سبق أن ظهر App Password أو مفتاح service_role في أي مكان عام، **غيّره فوراً**.
- حدود الحماية: 60 ثانية بين كل رمزين، 6 رموز/ساعة لكل بريد، 20 طلب/ساعة لكل IP، ورسالة موحّدة لا تكشف إن كان البريد مسجلاً.
