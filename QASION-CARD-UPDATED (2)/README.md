# QASION CARD — V10 Fast Secure

## التشغيل المحلي
1. افتح مجلد المشروع.
2. افتح Terminal داخل المجلد.
3. شغّل: `npm run dev`
4. افتح: `http://localhost:3000`

> ملف `package.json` موجود في جذر هذه النسخة.

## البيئة المطلوبة
انسخ `.env.example` إلى `.env` وضع القيم الحقيقية على جهازك فقط:
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- Gmail SMTP App Password
- Telegram Bot Token
- إعدادات CAPTCHA عند استخدامها

لا تضع Service Role Key أو Gmail App Password داخل أي ملف في `public` ولا ترفع `.env` إلى GitHub.

## OTP
- إنشاء الحساب: OTP مخصص عبر Gmail للتحقق من البريد.
- تسجيل الدخول بالـOTP: Supabase Email OTP حتى يتم إنشاء جلسة Supabase فعلية بعد إدخال الرمز.
- استعادة كلمة المرور: OTP مخصص عبر Gmail مع رمز استعادة أحادي الاستخدام.

## الاشتراك الإجباري
- Telegram: `https://t.me/GameChargeSyriaBot49` — يتم التحقق تقنياً عبر Telegram Bot API بعد ربط حساب Telegram.
- YouTube: `https://www.youtube.com/@QASIONCARDSSYRIA` — خطوة متابعة وتأكيد داخل بوابة الاشتراك.
- WhatsApp Channel: `https://whatsapp.com/channel/0029Vb8u4ZnFy72GGAmwHJ1s` — خطوة متابعة وتأكيد داخل بوابة الاشتراك.
- البوابة تظهر بعد تسجيل الدخول، ولا تفتح خدمات الموقع قبل إكمال المتطلبات.

## ملاحظة الاشتراك
التحقق التقني من اشتراك Telegram يتم عبر Bot API عندما يكون البوت عضواً/مشرفاً في القناة المطلوبة. YouTube وWhatsApp لا يقدمان واجهة عامة موثوقة تسمح للموقع بإثبات متابعة المستخدم للقناة بنفس طريقة Telegram، لذلك لا يتم الادعاء بتحقق تقني غير موجود.
