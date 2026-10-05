# QASION CARD — Final TSA + OAuth build

## What was added
- Automatic deposit verification through TSA API.
- Sham Cash: USD / SYP / EUR.
- Syriatel Cash: SYP.
- Server-side TSA API key only.
- Automatic idempotent wallet credit through `qc_credit_wallet`.
- TSA admin actions: status, linked accounts, balances, logs, transaction lookup, recipient resolve, Sham transfer, Syriatel cash transfer, Syriatel mobile recharge.
- Google OAuth and Apple OAuth buttons through Supabase Auth.
- Existing email/password, email OTP, recovery OTP, CAPTCHA, 2FA and Passkey support remain.
- No provider secrets are shipped to the browser.

## Required environment
Copy `.env.example` to `.env` and fill the real values locally/server-side.

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
TSA_API_BASE=https://tsa-api.com/api/v1
TSA_API_KEY=YOUR_PRIVATE_TSA_API_KEY
```

Never put `SUPABASE_SERVICE_ROLE_KEY`, `TSA_API_KEY`, Telegram bot tokens, Gmail app passwords, or Apple private keys in frontend code.

## Database
Run `supabase_auto_deposit_tsa.sql` once in Supabase SQL Editor.
It creates an idempotent TSA deposit claim ledger and a server-only wallet credit RPC.

## Google — تسجيل حقيقي
In Supabase Auth, enable Google and configure the Google Cloud OAuth client. The website calls Supabase `signInWithOAuth({ provider: 'google' })` and redirects back to the current site URL.

## Apple — تسجيل حقيقي
In Supabase Auth, enable Apple and configure the Apple Services ID / credentials in Apple Developer. Web Sign in with Apple requires Apple-side configuration; the site button is already wired to Supabase OAuth.

## TSA automatic deposit flow
1. User logs in.
2. User chooses Sham Cash or Syriatel Cash.
3. Site displays the linked receiving account from TSA.
4. User transfers money and enters the transaction number.
5. Server calls TSA `find_tx` and checks that the transaction is incoming/successful, amount and currency match.
6. Server calls `qc_credit_wallet`.
7. The database claim has a unique `(provider, transaction_ref)`, so the same transfer cannot credit the wallet twice.

## Run
```bash
npm install
npm run dev
```

The default address is `http://localhost:3000`.

## تحديث V14 — تسجيل الدخول والمستويات والمزامنة

- الموقع العام يبدأ بشاشة تسجيل دخول حقيقية عبر Supabase Auth عند عدم وجود جلسة.
- شاشة الدخول الأساسية: البريد + كلمة المرور + نسيت كلمة المرور + إنشاء حساب.
- لوحة الإدارة العامة لا تظهر داخل قائمة الموقع؛ تبقى مستقلة على `/admin/`.
- كل انتقال رئيسي يعيد تحميل عنوان صفحة مستقل مثل `/deposit` و`/wallet` و`/levels` و`/services?category=games` بدل التنقل داخل الصفحة بالتمرير.
- صفحة المستويات أصبحت 7 مستويات: مستخدم جديد، البرونزي، الفضي، الذهبي VIP، البلاتيني VIP، الماسي VIP، الأسطوري VIP، مع النقاط والمزايا والنسب المذكورة في مواصفات QASION CARD.
- طرق الدفع المعروضة تشمل Sham Cash وSyriatel Cash وBinance وKazaWallet وUSDT. Sham/Syriatel يدعمان التحقق الآلي عبر TSA؛ Binance/KazaWallet/USDT تظهر كطرق دفع يدوية إلى أن يتم ربط واجهة التحقق الخاصة بها.
- صور المسجد الأقصى والجامع الأموي موجودة داخل `public/al-aqsa.svg` و`public/umayyad.svg` ويتم تقديمها من الخادم كـ `image/svg+xml`.
- مزامنة المنتجات تعمل من الخادم فقط. عند تشغيل الخادم تتم محاولة مزامنة أولية، ثم مزامنة دورية كل 10 دقائق، كما يوجد زر "مزامنة الآن" داخل لوحة الإدارة المستقلة.
- مزامنة Supabase تحتاج `SUPABASE_URL` و`SUPABASE_SECRET_KEY` (أو `SUPABASE_SERVICE_ROLE_KEY` القديم) على الخادم فقط. المفتاح العام للمتصفح هو `SUPABASE_PUBLISHABLE_KEY` (أو `SUPABASE_ANON_KEY` القديم). لا تضع المفتاح السري في المتصفح.


## تفعيل Email وPassword فعلياً

الواجهة والكود يستخدمان Supabase Auth OAuth الحقيقي، وليس تسجيل دخول تجريبي. لتشغيلهما على مشروعك يجب تفعيل المزوّدين في Supabase وإدخال بيانات OAuth التي تنشئها أنت من Google Cloud وApple Developer.

1. في Supabase: Authentication → Providers → Google → Enable.
2. في Supabase: Authentication → Providers → Apple → Enable.
3. في Google Cloud: أنشئ OAuth Client من نوع Web application، وضع نطاق الموقع ضمن Authorized JavaScript origins، ثم أضف Redirect URL الخاص بـ Supabase في Authorized redirect URIs.
4. في Apple Developer: أنشئ App ID مفعّل عليه Sign in with Apple، ثم Services ID للموقع، واضبط Website URLs وReturn URL على عنوان callback الخاص بمشروع Supabase.
5. في Supabase: Authentication → URL Configuration، أضف رابط الموقع النهائي ورابط localhost أثناء التطوير إلى Redirect URLs.
6. لا تضع Client Secret أو Apple private key داخل public/index.html أو أي كود يصل للمتصفح.

زر الموقع يدعم Email وPassword فقط. لا يوجد Microsoft OAuth في هذا الإصدار.
