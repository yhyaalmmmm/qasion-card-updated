// فحص ذاتي شامل للوحة الإدارة والمتجر:  npm run test:admin
// بيشغّل السيرفر على منفذ مؤقت مع بيانات تجريبية ومزوّد/Supabase وهميين، ولا يلمس بياناتك.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const MP = 4710, SP = 4711;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
let pass = 0, failN = 0;
const ok = (c, name, extra) => { if (c) { pass++; console.log('  ✅', name); } else { failN++; console.log('  ❌', name, extra !== undefined ? '→ ' + JSON.stringify(extra).slice(0, 300) : ''); } };

// ---- خادم وهمي: Supabase + مزوّد ----
const orders = [];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', c => body += c); req.on('end', () => {
    const j = (st, d) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (u.pathname === '/auth/v1/user') return bearer === 'goodtoken' ? j(200, { id: '11111111-1111-1111-1111-111111111111', email: 'buyer@example.com' }) : j(401, {});
    if (u.pathname === '/auth/v1/admin/users' && req.method === 'GET') return j(200, { total: 2, users: [{ id: '11111111-1111-1111-1111-111111111111', email: 'buyer@example.com', created_at: '2026-09-01T00:00:00Z', email_confirmed_at: '2026-09-01T00:01:00Z' }, { id: '22222222-2222-2222-2222-222222222222', email: 'other@example.com', created_at: '2026-09-02T00:00:00Z' }] });
    if (/^\/auth\/v1\/admin\/users\/[0-9a-f-]{36}$/.test(u.pathname) && req.method === 'PUT') { mock.lastBan = JSON.parse(body); return j(200, {}); }
    if (u.pathname === '/rest/v1/qc_auto_deposit_claims') return j(200, [{ id: 'd1', user_id: '1', provider: 'shamcash', transaction_ref: 'T1', amount: 10, currency: 'USD', created_at: '2026-09-03T00:00:00Z' }, { id: 'd2', user_id: '2', provider: 'syriatel', transaction_ref: 'T2', amount: 5, currency: 'USD', created_at: '2026-09-04T00:00:00Z' }]);
    if (u.pathname === '/api/fastapi/products') return j(200, { data: { products: [{ id: 501, name: 'PUBG 60 UC', price: 1, gameName: 'PUBG', isActive: 1, minCount: 1, maxCount: 5, dynamicFields: [{ name: 'player_id', label: 'Player ID', type: 'text', required: true }] }, { id: 502, name: 'Free Fire 100', price: 2, gameName: 'Free Fire', isActive: 1 }] } });
    if (u.pathname.startsWith('/api/fastapi/requestorder/')) { orders.push(u.searchParams.get('player_id')); return j(200, { data: { order_number: 'PRV-' + orders.length } }); }
    j(404, {});
  });
}).listen(MP);

const env = { ...process.env, PORT: String(SP), DATA_DIR: dataDir, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'Adm!n-Pass-1', SUPPORT_USERNAME: 'support', SUPPORT_PASSWORD: 'Supp0rt-Pass', TRUST_PROXY: 'true', PROVIDER_RETRIES: '0',
  SUPABASE_URL: `http://127.0.0.1:${MP}`, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', MEGA_GAME_API_BASE: `http://127.0.0.1:${MP}`, MEGA_GAME_API_TOKEN: 'tok' };
const srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', d => srvLog += d); srv.stderr.on('data', d => srvLog += d);

function client(ip) {
  const jar = {};
  return async function call(method, p, body, extra = {}) {
    const headers = { 'x-forwarded-for': ip, ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...extra };
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (ck) headers.cookie = ck;
    const r = await fetch(`http://127.0.0.1:${SP}${p}`, { method, headers, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
    for (const sc of r.headers.getSetCookie?.() || []) { const [kv] = sc.split(';'); const [k, v] = kv.split('='); if (/Max-Age=0/.test(sc)) delete jar[k]; else jar[k] = v; }
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${SP}/api/site`); break; } catch { await sleep(250); } }
  const anon = client('9.9.9.1'), main = client('9.9.9.2'), sup = client('9.9.9.3'), brute = client('9.9.9.4'), buyer = client('9.9.9.5');
  const bearer = { Authorization: 'Bearer goodtoken' };

  console.log('\n[1] الحماية والدخول');
  ok((await anon('GET', '/api/admin/dashboard')).status === 401, 'لوحة المعلومات تتطلب دخول');
  ok((await anon('GET', '/api/rates')).status !== 401, 'مسار سعر الصرف ما عاد محجوب خلف الأدمن');
  ok((await anon('POST', '/api/admin/auth', { action: 'login', role: 'main', username: 'admin', password: 'wrong' })).status === 401, 'كلمة سر غلط مرفوضة');
  ok((await anon('POST', '/api/admin/auth', 'x=1', { 'Content-Type': 'text/plain' })).status === 403, 'طلب غير JSON مرفوض (CSRF)');
  ok((await anon('POST', '/api/admin/auth', { action: 'login' }, { Origin: 'https://evil.example' })).status === 403, 'طلب من موقع غريب مرفوض');
  for (let i = 0; i < 5; i++) await brute('POST', '/api/admin/auth', { action: 'login', role: 'main', username: 'admin', password: 'bad' + i });
  ok((await brute('POST', '/api/admin/auth', { action: 'login', role: 'main', username: 'admin', password: 'Adm!n-Pass-1' })).status === 429, 'قفل بعد 5 محاولات فاشلة (حتى بكلمة السر الصحيحة)');
  const lg = await main('POST', '/api/admin/auth', { action: 'login', role: 'main', username: 'admin', password: 'Adm!n-Pass-1' });
  ok(lg.status === 200 && lg.data.session.role === 'main', 'دخول الإدارة الرئيسية');
  ok(/HttpOnly/.test(lg.headers.get('set-cookie')) && /SameSite=Strict/.test(lg.headers.get('set-cookie')), 'الكوكي HttpOnly + SameSite=Strict');

  console.log('\n[2] المنتجات اليدوية');
  ok((await main('GET', '/api/products')).data.products.length === 0, 'الموقع يبدأ بلا منتجات وهمية');
  const bad = await main('POST', '/api/admin/products', { name: 'x', category: 'games', price: 1 });
  ok(bad.status === 400, 'رفض اسم قصير', bad.data);
  ok((await main('POST', '/api/admin/products', { name: 'Test', category: 'nope', price: 1 })).status === 400, 'رفض قسم غير موجود');
  ok((await main('POST', '/api/admin/products', { name: 'Test', category: 'games', price: -3 })).status === 400, 'رفض سعر سالب');
  ok((await main('POST', '/api/admin/products', { name: 'Test', category: 'games', price: 1, image: 'javascript:alert(1)' })).status === 400, 'رفض صورة javascript:');
  ok((await main('POST', '/api/admin/products', { name: 'Test', category: 'games', price: 1, minCount: 5, maxCount: 2 })).status === 400, 'رفض حدود كمية خاطئة');
  const c1 = await main('POST', '/api/admin/products', { name: 'شدات ببجي 60', category: 'games', gameName: 'PUBG', price: 1.2, cost: 1, currency: 'USD', minCount: 1, maxCount: 10, dynamicFields: [{ name: 'player_id', label: 'معرّف اللاعب', required: true }] });
  ok(c1.status === 201 && c1.data.product.id, 'إنشاء منتج صحيح', c1.data);
  ok((await main('POST', '/api/admin/products', { name: 'شدات ببجي 60', category: 'games', price: 2 })).status === 409, 'منع التكرار');
  const pub = (await anon('GET', '/api/products')).data.products;
  ok(pub.length === 1 && pub[0].cost === undefined && pub[0].source === undefined && pub[0].key === undefined, 'الزائر ما بيشوف التكلفة ولا بيانات داخلية', pub[0]);
  const pid = c1.data.product.id;
  const up = await main('PUT', `/api/admin/products/${pid}`, { price: 1.5, active: false });
  ok(up.status === 200 && up.data.product.price === 1.5, 'تعديل السعر');
  ok((await anon('GET', '/api/products')).data.products.length === 0, 'المنتج المخفي ما بيظهر للزبائن');
  await main('PUT', `/api/admin/products/${pid}`, { active: true });

  console.log('\n[3] استيراد وتصدير');
  const csv = 'name,category,price,cost,currency,minCount,maxCount,image,note,active\n"Free Fire 100, كاش",games,0.95,0.8,USD,1,5,,ملاحظة,true\nSteam 10$,cards,10.5,,USD,,,,,true\nبدون سعر,games,,,,,,,,true\nقسم غلط,zzz,3,,,,,,,true\n';
  const im = await main('POST', '/api/admin/products/import', { format: 'csv', data: csv, mode: 'merge' });
  ok(im.status === 200 && im.data.created === 2 && im.data.skipped === 2, 'استيراد CSV: 2 جديد و2 مرفوض', im.data);
  const imj = await main('POST', '/api/admin/products/import', { format: 'json', data: JSON.stringify([{ name: 'Steam 10$', category: 'cards', price: 11 }, { name: 'ChatGPT شهر', category: 'ai', price: 20 }]) });
  ok(imj.data.created === 1 && imj.data.updated === 1, 'استيراد JSON: تحديث الموجود وإضافة الجديد', imj.data);
  const ex = await main('GET', '/api/admin/products/export?format=csv');
  ok(typeof ex.data === 'string' && ex.data.includes('Steam 10$') && ex.data.includes('"Free Fire 100, كاش"'), 'تصدير CSV بشكل صحيح');
  const list = await main('GET', '/api/admin/products?limit=100');
  ok(list.data.total === 4, 'العدد الكلي 4', list.data.total);
  const ids = list.data.items.map(x => x.id);
  const bl = await main('POST', '/api/admin/products/bulk', { action: 'deactivate', ids: ids.slice(0, 2) });
  ok(bl.data.affected === 2, 'إخفاء جماعي');
  const rp = await main('POST', '/api/admin/products/bulk', { action: 'reprice', ids, value: 10 });
  const rl = (await main('GET', `/api/admin/products?q=${encodeURIComponent('شدات')}`)).data.items[0];
  ok(rl.price === 1.1 && rl.autoPrice === true, 'إعادة تسعير 10% من التكلفة', rl);

  console.log('\n[4] الطلبات (زبون مسجّل)');
  ok((await anon('POST', '/api/provider/order', { productId: pid, quantity: 1 })).status === 401, 'الطلب بدون تسجيل دخول مرفوض');
  ok((await anon('POST', '/api/provider/order', { productId: pid, quantity: 1 }, { Authorization: 'Bearer bad' })).status === 401, 'توكن غلط مرفوض');
  await main('PUT', `/api/admin/products/${pid}`, { active: true, autoPrice: false, price: 2 });
  ok((await buyer('POST', '/api/provider/order', { productId: pid, quantity: 1, fields: {} }, bearer)).status === 400, 'حقل معرّف اللاعب مطلوب');
  ok((await buyer('POST', '/api/provider/order', { productId: pid, quantity: 99, fields: { player_id: '1' } }, bearer)).status === 400, 'كمية خارج الحدود مرفوضة');
  const od = await buyer('POST', '/api/provider/order', { productId: pid, quantity: 3, fields: { player_id: '12345' }, price: 0.01 }, bearer);
  ok(od.status === 200 && od.data.order.total === 6, 'الطلب يُحسب بسعر الخادم (2×3=6) وليس بسعر الزبون', od.data);
  const oid = od.data.orderId;
  const ol = await main('GET', '/api/admin/orders');
  ok(ol.data.total === 1 && ol.data.items[0].userEmail === 'buyer@example.com' && ol.data.items[0].status === 'pending', 'الطلب ظاهر عند الإدارة بحالة قيد المراجعة');
  const pt = await main('PATCH', `/api/admin/orders/${oid}`, { status: 'completed', note: 'تم الشحن' });
  ok(pt.data.order.status === 'completed' && pt.data.order.history.length >= 2, 'تغيير حالة الطلب مع سجل');
  ok((await main('POST', `/api/admin/orders/${oid}/execute`)).status === 400, 'منتج يدوي ما بينرسل لمزوّد');

  console.log('\n[5] مزامنة المزوّد وتنفيذ الطلب');
  const sy = await main('POST', '/api/admin/products/sync');
  ok(sy.status === 200 && sy.data.created === 2, 'مزامنة من المزوّد: 2 منتج جديد', sy.data);
  const prov = (await main('GET', '/api/admin/products?source=provider')).data.items.find(x => x.name === 'PUBG 60 UC');
  ok(prov && prov.cost === 1 && prov.price === 1.03 && prov.automatic, 'سعر البيع = التكلفة + هامش الربح (3% الافتراضي)', prov);
  const pp = (await anon('GET', '/api/products')).data.products.find(x => x.name === 'PUBG 60 UC');
  ok(pp && pp.providers[0].server === 'server 1' && !JSON.stringify(pp).includes('mega'), 'اسم المزوّد مخفي عن الزبائن', pp);
  const od2 = await buyer('POST', '/api/provider/order', { productId: prov.id, server: 'server 1', quantity: 2, fields: { player_id: '777' } }, bearer);
  ok(od2.status === 200 && orders.length === 0, 'وضع المراجعة: ما انرسل للمزوّد قبل الموافقة');
  const ex2 = await main('POST', `/api/admin/orders/${od2.data.orderId}/execute`);
  ok(ex2.status === 200 && orders[0] === '777' && ex2.data.order.providerRef === 'PRV-1' && ex2.data.order.status === 'processing', 'موافقة الإدارة ترسل الطلب للمزوّد وتحفظ رقمه', ex2.data);
  ok((await main('POST', `/api/admin/orders/${od2.data.orderId}/execute`)).status === 409, 'منع التنفيذ المزدوج');
  const sy2 = await main('POST', '/api/admin/products/sync');
  ok(sy2.data.created === 0 && sy2.data.updated === 2, 'إعادة المزامنة ما بتكرر المنتجات', sy2.data);

  console.log('\n[6] صلاحيات الدعم');
  const dev = 'device-test-1234567890abcdef';
  const s1 = await sup('POST', '/api/admin/auth', { action: 'login', role: 'support', username: 'support', password: 'Supp0rt-Pass', deviceId: dev, deviceLabel: 'اختبار' });
  ok(s1.status === 403 && s1.data.deviceId === dev, 'جهاز الدعم الجديد يحتاج تفعيل');
  ok((await main('POST', '/api/admin/devices', { action: 'approve', device_id: dev, label: 'مكتب' })).status === 200, 'الإدارة تفعّل الجهاز');
  const s2 = await sup('POST', '/api/admin/auth', { action: 'login', role: 'support', username: 'support', password: 'Supp0rt-Pass', deviceId: dev });
  ok(s2.status === 200, 'دخول الدعم بعد التفعيل');
  ok((await sup('GET', '/api/admin/products')).status === 200, 'الدعم يشوف المنتجات');
  ok((await sup('POST', '/api/admin/products', { name: 'منتج الدعم', category: 'apps', price: 3 })).status === 201, 'الدعم يضيف منتج');
  ok((await sup('DELETE', `/api/admin/products/${pid}`)).status === 403, 'الدعم ما بيحذف منتج');
  ok((await sup('PUT', '/api/admin/settings', { siteName: 'x' })).status === 403, 'الدعم ما بيعدّل الإعدادات');
  ok((await sup('GET', '/api/admin/deposits')).status === 403, 'الدعم ما بيشوف الإيداعات');
  ok((await sup('GET', '/api/admin/audit')).status === 403, 'الدعم ما بيشوف سجل النشاط');
  ok((await sup('POST', `/api/admin/orders/${od2.data.orderId}/execute`)).status === 403, 'الدعم ما بينفّذ عند المزوّد');
  ok((await sup('GET', '/api/admin/users')).status === 200, 'الدعم يشوف المستخدمين (قراءة فقط)');
  ok((await sup('POST', '/api/admin/users/22222222-2222-2222-2222-222222222222/ban', { ban: true })).status === 403, 'الدعم ما بيوقف حسابات');
  ok((await main('POST', '/api/admin/devices', { action: 'revoke', device_id: dev })).status === 200 && (await sup('GET', '/api/admin/products')).status === 401, 'إلغاء الجهاز يقطع جلسته فوراً');

  console.log('\n[7] المستخدمون والإيداعات');
  const us = await main('GET', '/api/admin/users');
  ok(us.data.users.length === 2 && us.data.users[0].email === 'buyer@example.com', 'قائمة المستخدمين من Supabase');
  ok((await main('POST', '/api/admin/users/22222222-2222-2222-2222-222222222222/ban', { ban: true })).status === 200 && mock.lastBan.ban_duration === '876000h', 'إيقاف حساب');
  const dp = await main('GET', '/api/admin/deposits');
  ok(dp.data.items.length === 2 && dp.data.totals.USD === 15, 'الإيداعات + المجاميع', dp.data.totals);

  console.log('\n[8] الإعدادات والبنرات والصيانة');
  ok((await main('PUT', '/api/admin/settings', { support: { telegram: 'http://insecure' } })).status === 400, 'رابط دعم غير https مرفوض');
  ok((await main('PUT', '/api/admin/settings', { profitMargin: 900 })).status === 400, 'هامش ربح غير منطقي مرفوض');
  ok((await main('PUT', '/api/admin/settings', { banners: [{ title: 'x', image: 'javascript:1' }] })).status === 400, 'بنر بصورة خبيثة مرفوض');
  const st = await main('PUT', '/api/admin/settings', { siteName: 'قاسيون كارد', support: { telegram: 'https://t.me/qasion' }, announcement: { enabled: true, text: 'عرض اليوم' }, banners: [{ title: 'جديد', image: '/assets/banner-1.jpg', active: true }, { title: 'مخفي', image: '/assets/banner-2.jpg', active: false }] });
  ok(st.status === 200, 'حفظ الإعدادات', st.data);
  const site = (await anon('GET', '/api/site')).data;
  ok(site.siteName === 'قاسيون كارد' && site.banners.length === 1 && site.announcement.text === 'عرض اليوم' && site.support.telegram === 'https://t.me/qasion', '/api/site يعرض الإعدادات الجديدة والبنرات الفعّالة فقط');
  await main('PUT', '/api/admin/settings', { maintenance: { enabled: true, message: 'صيانة قصيرة' } });
  const mt = await anon('GET', '/api/products');
  ok(mt.status === 503 && mt.data.maintenance && (await anon('GET', '/api/site')).status === 200, 'وضع الصيانة يوقف الطلبات ويُبقي /api/site');
  ok((await main('GET', '/api/admin/dashboard')).status === 200, 'الإدارة تدخل أثناء الصيانة');
  await main('PUT', '/api/admin/settings', { maintenance: { enabled: false } });
  ok((await anon('GET', '/api/products')).status === 200, 'إيقاف الصيانة');
  await main('PUT', '/api/admin/settings', { orders: { mode: 'auto' } });
  const od3 = await buyer('POST', '/api/provider/order', { productId: prov.id, server: 'server 1', quantity: 1, fields: { player_id: '888' } }, bearer);
  ok(od3.status === 200 && orders[1] === '888', 'الوضع التلقائي ينفّذ فوراً عند المزوّد');
  await main('PUT', '/api/admin/settings', { orders: { mode: 'review' } });

  console.log('\n[9] رفع الصور');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const upl = await main('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + png.toString('base64') });
  ok(upl.status === 201 && /^\/uploads\/.+\.png$/.test(upl.data.url) && fs.existsSync(path.join(ROOT, 'public', upl.data.url)), 'رفع صورة PNG صحيحة', upl.data);
  if (upl.data.url) fs.unlinkSync(path.join(ROOT, 'public', upl.data.url));
  ok((await main('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64') })).status === 400, 'ملف مزيّف بامتداد صورة مرفوض');
  ok((await main('POST', '/api/admin/upload', { data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status === 400, 'SVG مرفوض');

  console.log('\n[10] لوحة المعلومات وسجل النشاط');
  const db = (await main('GET', '/api/admin/dashboard')).data;
  ok(db.products.total >= 6 && db.orders.total === 3 && db.orders.byStatus.completed === 1, 'إحصائيات حقيقية', { p: db.products.total, o: db.orders });
  const au = (await main('GET', '/api/admin/audit?limit=100')).data;
  ok(au.items.some(a => a.action === 'login.fail') && au.items.some(a => a.action === 'product.create') && au.items.some(a => a.action === 'order.execute'), 'سجل النشاط يوثّق الدخول الفاشل والتعديلات');
  ok(!JSON.stringify(au).includes('Adm!n-Pass'), 'سجل النشاط لا يحتوي كلمات سر');
  ok((await main('POST', '/api/admin/auth', { action: 'logout' })).status === 200 && (await main('GET', '/api/admin/dashboard')).status === 401, 'تسجيل الخروج يلغي الجلسة');

  console.log('\n[11] استمرار البيانات');
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  ok(saved.products.length >= 6 && saved.orders.length === 3 && saved.settings.siteName === 'قاسيون كارد', 'البيانات محفوظة بملف data/store.json');

  console.log(`\nالنتيجة: ${pass} نجح، ${failN} فشل`);
  srv.kill(); mock.close(); fs.rmSync(dataDir, { recursive: true, force: true });
  if (failN) { console.log('\n--- سجل الخادم ---\n' + srvLog.slice(-1500)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('اختبار انهار:', e); console.log(srvLog.slice(-1500)); srv.kill(); process.exit(1); });
