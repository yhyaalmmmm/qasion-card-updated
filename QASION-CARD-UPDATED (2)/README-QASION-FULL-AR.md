# QASION CARD — FULL PACKAGE

هذه النسخة تجمع واجهة QASION CARD مع الخادم المحلي، Supabase Auth، Gmail OTP، CAPTCHA، Telegram، TSA، ومصادر المنتجات.

## ترتيب المصادر

- Server 1: Mega Game — `https://mega-game.net`
- Server 2: Gift4Card — `https://api.gift4card.com/`
- Server 3: SW Game — `https://sw-games.net`
- Social: Fast70 — `https://fast70.com/api/v2`
- Payments: TSA — `https://tsa-api.com/api/v1`

أسماء المزودين لا تظهر للمستخدم النهائي؛ الواجهة تعرض Server 1 / Server 2 / Server 3.

## 1) تشغيل محلي

افتح Terminal داخل المجلد الذي يحتوي `package.json`:

```bash
npm install
npm run dev
```

ثم افتح:

`http://localhost:3000`

## 2) ملف البيئة

انسخ `.env.example` إلى `.env` في **نفس المجلد الذي فيه package.json وserver.js**.

لا تضع `.env` داخل `public` ولا ترفعها إلى GitHub.

## 3) ماذا تضع في .env ومن أين؟

### Supabase
من Supabase Dashboard → Settings → API:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=ضع_الـ_anon_أو_publishable_المخصص_للمتصفح
SUPABASE_SERVICE_ROLE_KEY=ضع_service_role_أو_secret_للسيرفر_فقط
```

لا ترسل `SUPABASE_SERVICE_ROLE_KEY` إلى أي شخص ولا تضعه داخل HTML.

### Mega Game — Server 1
من لوحة Mega Game / API Access:

```env
MEGA_GAME_API_BASE=https://mega-game.net
MEGA_GAME_API_TOKEN=ضع_توكن_Mega
```

النسخة تستخدم `/api/fastapi/products` لجلب المنتجات وRequest Order لإنشاء طلبات الشحن.

### Gift4Card — Server 2
من لوحة Gift4Card/API:

```env
GIFT4CARD_API_BASE=https://api.gift4card.com/
GIFT4CARD_API_TOKEN=ضع_توكن_Gift4Card
GIFT4CARD_PRODUCTS_PATH=/client/api/products
```

إذا أعطاك Gift4Card مساراً مختلفاً للمنتجات، غيّر فقط `GIFT4CARD_PRODUCTS_PATH`.

### SW Game — Server 3
من SW Game → API Access:

```env
SW_GAME_API_BASE=https://sw-games.net
SW_GAME_API_TOKEN=ضع_توكن_SW
```

الـ Products endpoint الموثق هو `/api/fastapi/products`، والطلب يستخدم Request Order مع dynamic fields وUUID.

### Fast70 — Social
من لوحة Fast70:

```env
FAST70_API_BASE=https://fast70.com/api/v2
FAST70_API_TOKEN=ضع_API_KEY_الخاص_بك
```

Fast70 يبقى للسوشيال فقط.

### TSA — الإيداعات
من TSA Dashboard → API:

```env
TSA_API_BASE=https://tsa-api.com/api/v1
TSA_API_KEY=ضع_مفتاح_TSA
```

يُستخدم للتحقق من حوالات Sham Cash وSyriatel Cash وإضافة الرصيد بشكل idempotent عبر قاعدة البيانات.

### Gmail OTP
من حساب Gmail الذي سيرسل رموز OTP فعّل 2-Step Verification ثم أنشئ App Password:

```env
GMAIL_SMTP_HOST=smtp.gmail.com
GMAIL_SMTP_PORT=465
GMAIL_SMTP_USER=qasioncard@gmail.com
GMAIL_SMTP_APP_PASSWORD=ضع_App_Password_وليس_كلمة_مرور_Gmail
GMAIL_FROM_EMAIL=qasioncard@gmail.com
GMAIL_FROM_NAME=QASION CARD
```

### Telegram
من BotFather:

```env
TELEGRAM_BOT_USERNAME=qasioncardssyria_bot
TELEGRAM_BOT_TOKEN=ضع_توكن_البوت
```

وللقنوات الإلزامية:

```env
FORCED_CHANNELS_REQUIRED=true
FORCED_CHANNELS=QASION CARD|@GameChargeBot49
```

يجب أن يكون البوت قادراً على قراءة عضوية القناة حتى يعمل `getChatMember`.

### Cloudflare Turnstile
من Cloudflare Turnstile:

```env
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

إذا تركتهما فارغين، النسخة تستخدم CAPTCHA الحسابي الآمن الموجود في الخادم.

### سعر الصرف
اختياري:

```env
EXCHANGE_RATE_API_URL=
EXCHANGE_RATE_API_KEY=
```

إذا لم تضع مزود سعر صرف، سيظهر سعر الصرف غير متاح بدلاً من اختراع سعر.

### هامش الربح
```env
PROFIT_MARGIN=0.03
```

`0.03` يعني إضافة 3% على سعر المصدر قبل العرض. غيّره حسب سياسة QASION CARD.

## 4) Supabase SQL

شغّل ملفات SQL من Supabase → SQL Editor بالترتيب:

1. `supabase_custom_auth.sql`
2. `supabase_auth_security.sql`
3. `supabase_admin_security.sql`
4. `supabase_auto_deposit_tsa.sql`

إذا كانت الجداول والسياسات موجودة عندك بالفعل، لا تعيد تشغيل أي migration قديمة بشكل عشوائي؛ راجع الخطأ أولاً.

## 5) Vercel

عند النشر، ضع **نفس متغيرات البيئة** في Vercel → Project → Settings → Environment Variables، مع فصل Production/Preview حسب حاجتك.

لا ترفع `.env` إلى GitHub.

## 6) ما الذي يعمل في هذه النسخة؟

- خادم Node محلي.
- Supabase Auth backend hooks الموجودة في المشروع.
- Gmail OTP.
- Recovery OTP.
- CAPTCHA.
- Telegram link/verification.
- TSA status/accounts/automatic deposit verification.
- جلب كتالوج Mega Game وSW Game من API الحقيقي عند وضع التوكن.
- جلب Fast70 للسوشيال عند وضع المفتاح.
- دعم Gift4Card عبر مسار المنتجات القابل للضبط.
- دمج المنتج المتكرر في بطاقة واحدة مع Server 1 / Server 2 / Server 3.
- قراءة dynamic fields من مصدر الشحن بدلاً من اختراع Player ID أو Code ثابت.
- إرسال طلبات Mega/SW مع UUID لمنع التكرار.
- إرسال طلبات Fast70 بطريقة الخادم.
- عدم وضع مفاتيح المزودين في المتصفح.

## ملاحظة مهمة

لا يتم اعتبار أي مصدر متصلاً فعلياً قبل وضع التوكن الصحيح واختبار endpoint. إذا بقي التوكن فارغاً، الموقع يعرض قائمة فارغة بدلاً من إضافة منتجات وهمية.
