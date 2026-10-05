// لوحة إدارة QASION CARD — الخادم: دخول آمن، صلاحيات، منتجات، طلبات، مستخدمون، إعدادات، سجل نشاط.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const CATEGORIES = [
  ['games', 'شحن الألعاب'], ['apps', 'شحن التطبيقات'], ['social', 'دعم سوشيال ميديا'], ['cards', 'بطاقات إلكترونية'],
  ['crypto', 'عملات إلكترونية'], ['accounts', 'حسابات'], ['ai', 'اشتراكات AI'], ['payments', 'مدفوعات إلكترونية'],
  ['software', 'أدوات السوفتوير'], ['microsoft', 'منتجات مايكروسوفت'], ['pc', 'برامج الكمبيوتر'], ['iptv', 'اشتراكات IPTV'],
  ['sites', 'صمم متجرك'], ['special', 'الصيد والاتصالات'], ['gifts', 'الهدايا والمكافآت']
];
const CAT_KEYS = new Set(CATEGORIES.map(c => c[0]));
const CURRENCIES = ['USD', 'SYP', 'EUR', 'USDT'];
const ORDER_STATUSES = ['pending', 'processing', 'completed', 'rejected', 'failed', 'cancelled'];
const FIELD_TYPES = new Set(['text', 'number', 'url', 'email']);
const SESSION_TTL = 8 * 3600 * 1000;
const COOKIE = 'qc_admin';

// ما يستطيع الدعم فعله (الإدارة الرئيسية تستطيع كل شيء)
const SUPPORT_PERMS = new Set([
  'dashboard', 'products.read', 'products.write', 'products.sync', 'orders.read', 'orders.write',
  'users.read', 'settings.read', 'providers.read', 'upload'
]);

function createAdmin(ctx) {
  const { USERS, json, env, supaAdmin, liveCatalog, executeOrder, cleanName, publicDir } = ctx;
  const maxSupportDevices = ctx.maxSupportDevices || 2;
  const sessions = new Map();
  const fails = new Map();

  // ---------- أدوات عامة ----------
  const now = () => new Date().toISOString();
  const uid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const clip = (v, n) => String(v ?? '').trim().slice(0, n);
  const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));
  const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  const trustProxy = () => String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
  function ipOf(req) {
    if (trustProxy()) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
    return req.socket?.remoteAddress || 'unknown';
  }
  function safeEq(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }
  function parseCookie(req, name) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? m[1] : null;
  }
  function readJson(req, limit = 1e6) {
    return new Promise((resolve, reject) => {
      let b = '', size = 0;
      req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('الطلب كبير جداً'), { status: 413 })); req.destroy(); return; } b += c; });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(Object.assign(new Error('JSON غير صالح'), { status: 400 })); } });
      req.on('error', reject);
    });
  }
  function csrfOk(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    if (!String(req.headers['content-type'] || '').includes('application/json')) return false;
    const o = req.headers.origin;
    if (o) { try { if (new URL(o).host !== req.headers.host) return false; } catch { return false; } }
    return true;
  }
  const can = (s, p) => s.role === 'main' || SUPPORT_PERMS.has(p);
  function audit(s, action, detail, req) {
    store.mutate(d => {
      d.audit.push({ id: uid('a'), at: now(), user: s?.username || '-', role: s?.role || '-', ip: req ? ipOf(req) : '', action, detail: clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 500) });
      if (d.audit.length > 2000) d.audit.splice(0, d.audit.length - 2000);
    });
  }
  function getSession(req) {
    const t = parseCookie(req, COOKIE);
    const s = t ? sessions.get(t) : null;
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(t); return null; }
    return s;
  }
  const safeUser = (s) => ({ role: s.role, username: s.username, deviceLabel: s.deviceLabel });
  function setCookie(res, req, t) {
    res.setHeader('Set-Cookie', `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}${isHttps(req) ? '; Secure' : ''}`);
  }
  function clearCookie(res, req) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isHttps(req) ? '; Secure' : ''}`);
  }
  function paginate(arr, u, def = 25) {
    const limit = Math.min(100, Math.max(1, parseInt(u.searchParams.get('limit')) || def));
    const total = arr.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, Math.max(1, parseInt(u.searchParams.get('page')) || 1));
    return { items: arr.slice((page - 1) * limit, page * limit), total, page, pages, limit };
  }

  // ---------- تسجيل الدخول ----------
  function lockedFor(ip) { const f = fails.get(ip); return f && f.until && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; }
  function recordFail(ip) {
    const f = fails.get(ip) || { n: 0, first: Date.now() };
    if (Date.now() - f.first > 15 * 60e3) { f.n = 0; f.first = Date.now(); f.until = 0; }
    f.n++; if (f.n >= 5) f.until = Date.now() + 15 * 60e3;
    fails.set(ip, f);
  }
  function login(body, req) {
    const ip = ipOf(req);
    const wait = lockedFor(ip);
    if (wait) return { status: 429, error: `محاولات كثيرة. حاول بعد ${Math.ceil(wait / 60)} دقيقة.` };
    const u = USERS[body.role];
    if (!u || !u.password) return { status: 400, error: 'لم يتم ضبط كلمة سر هذا الحساب في ملف .env' };
    const okUser = safeEq(clip(body.username, 100), u.username);
    const okPass = safeEq(String(body.password ?? ''), u.password);
    if (!(okUser && okPass)) { recordFail(ip); audit({ username: clip(body.username, 40), role: body.role }, 'login.fail', 'محاولة دخول فاشلة', req); return { status: 401, error: 'اسم المستخدم أو كلمة السر غير صحيحة' }; }
    let deviceLabel = 'الإدارة الرئيسية', deviceId = 'main';
    if (u.role === 'support') {
      deviceId = clip(body.deviceId, 120);
      if (deviceId.length < 16) return { status: 400, error: 'معرّف الجهاز غير صالح. حدّث الصفحة وحاول مجدداً.' };
      const r = store.mutate(d => {
        let dev = d.devices.find(x => x.device_id === deviceId && x.username === u.username);
        if (!dev) {
          const approved = d.devices.filter(x => x.username === u.username && x.approved).length;
          if (approved >= maxSupportDevices) return { error: `وصلت لحد أجهزة الدعم (${maxSupportDevices}). اطلب من الإدارة الرئيسية تفعيل هذا الجهاز.`, deviceId };
          dev = { device_id: deviceId, username: u.username, label: clip(body.deviceLabel, 60) || 'جهاز غير مسمى', approved: false, created_at: now() };
          d.devices.push(dev);
        }
        if (!dev.approved) return { error: 'هذا الجهاز غير مفعّل. أعطِ معرّف الجهاز للإدارة الرئيسية لتفعيله.', deviceId };
        dev.last_login = now(); deviceLabel = dev.label || deviceLabel;
        return {};
      });
      if (r.error) return { status: 403, error: r.error, deviceId: r.deviceId };
    }
    fails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const s = { role: u.role, username: u.username, deviceId, deviceLabel, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL, ip };
    sessions.set(token, s);
    audit(s, 'login.ok', 'تسجيل دخول', req);
    return { session: s, token };
  }

  // ---------- المنتجات ----------
  function calcPrice(cost, margin) { return Math.round(cost * (1 + margin / 100) * 10000) / 10000; }
  function margin() { const m = Number(store.get().settings.profitMargin); return Number.isFinite(m) ? m : 3; }
  function validImage(v) { v = String(v || '').trim(); return v === '' || /^\/[A-Za-z0-9._\-\/]+$/.test(v) || /^https:\/\/[^\s"'<>]+$/i.test(v); }

  function cleanFields(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const f of list.slice(0, 8)) {
      const name = clip(f?.name, 40).replace(/[^A-Za-z0-9_]/g, '');
      if (!name) continue;
      out.push({ name, label: clip(f.label, 60) || name, type: FIELD_TYPES.has(f.type) ? f.type : 'text', placeholder: clip(f.placeholder, 80), help_text: clip(f.help_text, 120), required: f.required !== false });
    }
    return out;
  }

  // يتحقق من منتج مُدخل يدوياً. يرجع {error} أو {product}
  function cleanProduct(input, existing) {
    const e = existing || {};
    const name = clip(input.name ?? e.name, 140);
    if (name.length < 2) return { error: 'اسم المنتج مطلوب (حرفان على الأقل)' };
    const category = clip(input.category ?? e.category, 30);
    if (!CAT_KEYS.has(category)) return { error: 'القسم غير صحيح' };
    const currency = String(input.currency ?? e.currency ?? 'USD').toUpperCase();
    if (!CURRENCIES.includes(currency)) return { error: 'العملة غير مدعومة' };
    const minCount = parseInt(input.minCount ?? e.minCount ?? 1), maxCount = parseInt(input.maxCount ?? e.maxCount ?? 1);
    if (!(minCount >= 1) || !(maxCount >= minCount) || maxCount > 1000000) return { error: 'حدود الكمية غير صحيحة (الأدنى ≥ 1 والأقصى ≥ الأدنى)' };
    const image = clip(input.image ?? e.image, 500);
    if (!validImage(image)) return { error: 'رابط الصورة غير صالح (يجب أن يبدأ بـ / أو https://)' };
    const hasProviders = Array.isArray(e.providers) && e.providers.length > 0;
    const costRaw = input.cost !== undefined ? input.cost : e.cost;
    const cost = costRaw === '' || costRaw === null || costRaw === undefined ? null : Number(costRaw);
    if (cost !== null && !(Number.isFinite(cost) && cost >= 0)) return { error: 'سعر التكلفة غير صحيح' };
    const autoPrice = (input.autoPrice !== undefined ? !!input.autoPrice : !!e.autoPrice) && cost !== null;
    let price = num(input.price ?? e.price);
    if (autoPrice) price = calcPrice(cost, margin());
    if (!(Number.isFinite(price) && price >= 0 && price < 1e9)) return { error: 'سعر البيع غير صحيح' };
    const p = {
      id: e.id || uid('p'),
      name, category,
      gameName: clip(input.gameName ?? e.gameName, 140) || name,
      price: Math.round(price * 10000) / 10000,
      cost, autoPrice, currency,
      image, note: clip(input.note ?? e.note, 300),
      minCount, maxCount,
      dynamicFields: input.dynamicFields !== undefined ? cleanFields(input.dynamicFields) : (e.dynamicFields || []),
      active: input.active !== undefined ? !!input.active : (e.active !== undefined ? !!e.active : true),
      sort: Number.isFinite(parseInt(input.sort ?? e.sort)) ? parseInt(input.sort ?? e.sort) : 0,
      source: e.source || 'manual',
      key: `${category}|${cleanName(name)}`,
      providers: hasProviders ? e.providers : [],
      createdAt: e.createdAt || now(), updatedAt: now()
    };
    if (e.missingSince) p.missingSince = e.missingSince;
    return { product: p };
  }
  function adminProduct(p) { return { ...p, automatic: (p.providers || []).length > 0, serverCount: (p.providers || []).length, providers: (p.providers || []).map(x => ({ server: x.server, source: x.source })) }; }
  // ما يراه الزائر: بدون أي اسم مزوّد أو تكلفة
  function publicProduct(p) {
    return {
      id: p.id, name: p.name, gameName: p.gameName, category: p.category, price: p.price, currency: p.currency,
      image: p.image || '', note: p.note || '', minCount: p.minCount, maxCount: p.maxCount,
      dynamicFields: p.dynamicFields || [], automatic: (p.providers || []).length > 0, serverCount: (p.providers || []).length,
      providers: (p.providers || []).map(x => ({ server: x.server, dynamicFields: x.dynamicFields || p.dynamicFields || [], minCount: x.minCount || p.minCount, maxCount: x.maxCount || p.maxCount }))
    };
  }
  function publicProducts() {
    return store.get().products.filter(p => p.active).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name)).map(publicProduct);
  }

  function csvEscape(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    text = String(text).replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',' || c === ';' || c === '\t') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
  }
  const CSV_COLS = ['name', 'category', 'gameName', 'price', 'cost', 'currency', 'minCount', 'maxCount', 'image', 'note', 'active'];
  const CAT_AR = Object.fromEntries(CATEGORIES.map(([k, v]) => [v, k]));

  function importProducts(rows, mode) {
    const res = { created: 0, updated: 0, skipped: 0, errors: [] };
    if (rows.length > 5000) return { error: 'الحد الأقصى 5000 منتج في المرة الواحدة' };
    store.mutate(d => {
      if (mode === 'replace') d.products = d.products.filter(p => p.source !== 'manual');
      const byKey = new Map(d.products.map(p => [p.key, p]));
      rows.forEach((raw, i) => {
        const line = i + 1;
        const inp = { ...raw };
        for (const k of ['minCount', 'maxCount', 'sort', 'currency', 'category']) if (inp[k] === '') delete inp[k];
        if (CAT_AR[inp.category]) inp.category = CAT_AR[inp.category];
        if (typeof inp.active === 'string') inp.active = !['false', '0', 'no', 'لا', 'مخفي', ''].includes(inp.active.trim().toLowerCase());
        const key = `${clip(inp.category, 30)}|${cleanName(clip(inp.name, 140))}`;
        const ex = byKey.get(key);
        const r = cleanProduct(inp, ex);
        if (r.error) { res.skipped++; if (res.errors.length < 50) res.errors.push({ row: line, error: r.error }); return; }
        if (ex) { Object.assign(ex, r.product); res.updated++; }
        else { d.products.push(r.product); byKey.set(r.product.key, r.product); res.created++; }
      });
    });
    return res;
  }

  async function syncFromProviders() {
    const live = await liveCatalog(true);
    if (!live.length) {
      const diag = ctx.productStatus ? ctx.productStatus().providers : [];
      return { error: 'تعذر جلب أي منتج من المزودين. تحقق من التوكنات والاتصال (تبويب المزودين).', diagnostics: diag };
    }
    const m = margin(); const res = { created: 0, updated: 0, total: live.length, missing: 0 };
    store.mutate(d => {
      const byKey = new Map(d.products.map(p => [p.key, p]));
      const seen = new Set();
      for (const it of live) {
        const cat = it.category === 'game' ? 'games' : it.category;
        if (!CAT_KEYS.has(cat)) continue;
        const key = `${cat}|${cleanName(it.name)}`; seen.add(key);
        const providers = it.providers.map(x => ({ server: x.server, source: x.source, external_id: x.external_id, cost: x.price, currency: x.currency, dynamicFields: x.dynamicFields || [], minCount: x.minCount || 1, maxCount: x.maxCount || 1 }));
        let p = byKey.get(key);
        if (!p) {
          p = { id: uid('p'), name: clip(it.name, 140), category: cat, gameName: clip(it.gameName || it.name, 140), price: calcPrice(it.price, m), cost: it.price, autoPrice: true, currency: it.currency || 'USD', image: validImage(it.image) ? clip(it.image, 500) : '', note: clip(it.note, 300), minCount: it.minCount || 1, maxCount: Math.max(it.maxCount || 1, it.minCount || 1), dynamicFields: cleanFields(it.dynamicFields), active: true, sort: 0, source: 'provider', key, providers, createdAt: now(), updatedAt: now() };
          d.products.push(p); byKey.set(key, p); res.created++;
        } else {
          p.providers = providers; p.cost = it.price; p.currency = it.currency || p.currency;
          if (p.autoPrice) p.price = calcPrice(it.price, m);
          if (!p.image && validImage(it.image)) p.image = clip(it.image, 500);
          if (p.source === 'provider') { p.minCount = it.minCount || p.minCount; p.maxCount = Math.max(it.maxCount || p.maxCount, p.minCount); p.dynamicFields = cleanFields(it.dynamicFields); if (!p.note) p.note = clip(it.note, 300); }
          delete p.missingSince; p.updatedAt = now(); res.updated++;
        }
      }
      for (const p of d.products) if (p.source === 'provider' && !seen.has(p.key)) { if (!p.missingSince) p.missingSince = now(); res.missing++; }
    });
    return res;
  }

  // ---------- الطلبات ----------
  function publicOrder(o) { return { id: o.id, productName: o.productName, quantity: o.quantity, total: o.total, currency: o.currency, status: o.status, createdAt: o.createdAt }; }
  function pushHistory(o, by, status, note) { (o.history = o.history || []).push({ at: now(), by, status, note: clip(note, 300) }); if (o.history.length > 50) o.history.shift(); }

  async function runExecution(orderId, byName) {
    const snap = store.get().orders.find(o => o.id === orderId);
    if (!snap) return { error: 'الطلب غير موجود' };
    const prod = store.get().products.find(p => p.id === snap.productId);
    const item = prod && (prod.providers || []).find(x => x.server === snap.server) || prod?.providers?.[0];
    if (!item) return { error: 'هذا المنتج غير مرتبط بمزوّد؛ نفّذه يدوياً ثم غيّر الحالة إلى مكتمل.' };
    store.mutate(() => { snap.execution = 'provider'; snap.updatedAt = now(); pushHistory(snap, byName, 'processing', 'إرسال الطلب للمزوّد'); snap.status = 'processing'; });
    try {
      const up = await executeOrder(item, snap.fields, snap.quantity, snap.uuid || snap.id);
      const ref = String(up?.data?.order_number ?? up?.data?.order?.order_number ?? up?.order ?? up?.order_number ?? '').slice(0, 80);
      store.mutate(() => { snap.providerRef = ref; snap.providerResponse = clip(JSON.stringify(up), 1500); snap.error = ''; snap.updatedAt = now(); pushHistory(snap, byName, 'processing', ref ? `رقم المزوّد: ${ref}` : 'تم الإرسال'); });
      return { ok: true, order: snap };
    } catch (e) {
      const msg = e.message === 'PROVIDER_NOT_CONFIGURED' ? 'مفتاح المزوّد غير مضبوط في .env' : e.message === 'GIFT4CARD_ORDER_NOT_CONFIGURED' ? 'تنفيذ طلبات Gift4Card غير مفعّل' : clip(e.message, 200);
      store.mutate(() => { snap.status = 'failed'; snap.error = msg; snap.updatedAt = now(); pushHistory(snap, byName, 'failed', msg); });
      return { error: msg, order: snap };
    }
  }

  // يُستدعى من خادم الموقع عند طلب زبون مسجّل الدخول
  async function createOrder({ user, productId, server, quantity, fields }) {
    const settings = store.get().settings;
    const p = store.get().products.find(x => x.id === productId && x.active);
    if (!p) return { status: 404, message: 'المنتج غير موجود أو غير متاح' };
    const providers = p.providers || [];
    let item = null;
    if (providers.length) { item = providers.find(x => x.server === server) || (providers.length === 1 ? providers[0] : null); if (!item) return { status: 400, message: 'اختر سيرفراً صحيحاً لهذا المنتج' }; }
    const min = item?.minCount || p.minCount, max = item?.maxCount || p.maxCount;
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < min || qty > max) return { status: 400, message: `الكمية يجب أن تكون بين ${min} و${max}` };
    const defs = (item?.dynamicFields?.length ? item.dynamicFields : p.dynamicFields) || [];
    const clean = {};
    for (const f of defs) {
      const v = clip(fields && fields[f.name], 300);
      if (f.required && !v) return { status: 400, message: `الحقل مطلوب: ${f.label || f.name}` };
      if (v) {
        if (f.type === 'number' && !/^\d+(\.\d+)?$/.test(v)) return { status: 400, message: `قيمة غير صحيحة: ${f.label || f.name}` };
        if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) return { status: 400, message: `رابط غير صحيح: ${f.label || f.name}` };
        if (f.type === 'email' && !/^\S+@\S+\.\S+$/.test(v)) return { status: 400, message: `بريد غير صحيح: ${f.label || f.name}` };
        clean[f.name] = v;
      }
    }
    const total = Math.round(p.price * qty * 10000) / 10000;
    const o = {
      id: 'ORD-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
      userId: clip(user.id, 80), userEmail: clip(user.email, 160), productId: p.id, productName: p.name, category: p.category,
      server: item ? item.server : '', quantity: qty, fields: clean, unitPrice: p.price, total, currency: p.currency,
      uuid: crypto.randomUUID(), status: 'pending', execution: item ? 'provider' : 'manual', providerRef: '', error: '', note: '', createdAt: now(), updatedAt: now(), history: []
    };
    pushHistory(o, 'الزبون', 'pending', 'تم إنشاء الطلب');
    store.mutate(d => { d.orders.push(o); });
    if (settings.orders.mode === 'auto' && item) await runExecution(o.id, 'تلقائي');
    return { ok: true, order: store.get().orders.find(x => x.id === o.id) };
  }

  // ---------- المستخدمون / الإيداعات (Supabase) ----------
  const supaConfigured = () => !!(env('SUPABASE_URL') && (env('SUPABASE_SECRET_KEY') || env('SUPABASE_SERVICE_ROLE_KEY')));
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ---------- الإعدادات ----------
  function cleanUrl(v, label) {
    v = clip(v, 300); if (!v) return { v: '' };
    if (!/^https:\/\/[^\s"'<>]+$/i.test(v)) return { error: `${label}: يجب أن يكون رابط https صحيحاً` };
    return { v };
  }
  function cleanSettings(inp, cur) {
    const out = JSON.parse(JSON.stringify(cur));
    if (inp.siteName !== undefined) { const v = clip(inp.siteName, 60); if (!v) return { error: 'اسم الموقع مطلوب' }; out.siteName = v; }
    if (inp.siteDescription !== undefined) out.siteDescription = clip(inp.siteDescription, 200);
    if (inp.support) {
      for (const k of ['telegram', 'whatsapp', 'youtube']) if (inp.support[k] !== undefined) { const r = cleanUrl(inp.support[k], k); if (r.error) return r; out.support[k] = r.v; }
      if (inp.support.email !== undefined) { const v = clip(inp.support.email, 120); if (v && !/^\S+@\S+\.\S+$/.test(v)) return { error: 'بريد الدعم غير صحيح' }; out.support.email = v; }
    }
    if (inp.maintenance) { if (inp.maintenance.enabled !== undefined) out.maintenance.enabled = !!inp.maintenance.enabled; if (inp.maintenance.message !== undefined) out.maintenance.message = clip(inp.maintenance.message, 300) || cur.maintenance.message; }
    if (inp.announcement) { if (inp.announcement.enabled !== undefined) out.announcement.enabled = !!inp.announcement.enabled; if (inp.announcement.text !== undefined) out.announcement.text = clip(inp.announcement.text, 200); if (out.announcement.enabled && !out.announcement.text) return { error: 'اكتب نص الإعلان أو عطّله' }; }
    if (inp.profitMargin !== undefined) { const m = Number(inp.profitMargin); if (!(Number.isFinite(m) && m >= 0 && m <= 500)) return { error: 'نسبة الربح يجب أن تكون بين 0 و500' }; out.profitMargin = m; }
    if (inp.orders?.mode !== undefined) { if (!['review', 'auto'].includes(inp.orders.mode)) return { error: 'وضع الطلبات غير صحيح' }; out.orders.mode = inp.orders.mode; }
    if (inp.forcedChannels && inp.forcedChannels.required !== undefined) { const r = inp.forcedChannels.required; if (![null, true, false].includes(r)) return { error: 'قيمة الاشتراك الإجباري غير صحيحة' }; out.forcedChannels.required = r; }
    if (inp.banners !== undefined) {
      if (!Array.isArray(inp.banners) || inp.banners.length > 10) return { error: 'الحد الأقصى 10 بنرات' };
      const list = [];
      for (const [i, b] of inp.banners.entries()) {
        const image = clip(b.image, 500); if (!image || !validImage(image)) return { error: `البنر ${i + 1}: رابط الصورة غير صالح` };
        const mobile = clip(b.mobile, 500); if (!validImage(mobile)) return { error: `البنر ${i + 1}: رابط صورة الموبايل غير صالح` };
        const link = clip(b.link, 300); if (link && !/^(\/[^\s"'<>]*|https:\/\/[^\s"'<>]+)$/i.test(link)) return { error: `البنر ${i + 1}: الرابط غير صالح` };
        list.push({ id: clip(b.id, 40) || uid('b'), title: clip(b.title, 80), image, mobile, link, active: b.active !== false, sort: Number.isFinite(parseInt(b.sort)) ? parseInt(b.sort) : i + 1 });
      }
      out.banners = list;
    }
    return { settings: out };
  }
  function publicSettings() {
    const s = store.get().settings;
    return {
      siteName: s.siteName, siteDescription: s.siteDescription, support: s.support,
      maintenance: { enabled: !!s.maintenance.enabled, message: s.maintenance.message },
      announcement: s.announcement.enabled ? { text: s.announcement.text } : null,
      banners: s.banners.filter(b => b.active).sort((a, b) => a.sort - b.sort).map(b => ({ id: b.id, title: b.title, image: b.image, mobile: b.mobile || b.image, link: b.link || '' }))
    };
  }

  // ---------- لوحة المعلومات ----------
  function systemChecks() {
    const has = (...k) => k.every(x => !!env(x));
    return [
      { key: 'admin', label: 'كلمة سر الإدارة الرئيسية', ok: !!USERS.main.password, hint: 'ضع ADMIN_PASSWORD في .env' },
      { key: 'support', label: 'كلمة سر الدعم', ok: !!USERS.support.password, hint: 'ضع SUPPORT_PASSWORD في .env (اختياري)', optional: true },
      { key: 'supabase', label: 'Supabase (الحسابات والمستخدمون)', ok: supaConfigured() && !!(env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY')), hint: 'SUPABASE_URL + المفاتيح' },
      { key: 'mail', label: 'بريد Gmail (رموز التحقق)', ok: has('GMAIL_SMTP_USER') && !!(env('GMAIL_SMTP_APP_PASSWORD') || env('GMAIL_SMTP_PASSWORD')), hint: 'GMAIL_SMTP_USER و GMAIL_SMTP_APP_PASSWORD' },
      { key: 'providers', label: 'مزوّدو المنتجات', ok: ['MEGA_GAME', 'GIFT4CARD', 'SW_GAME', 'FAST70'].some(p => env(p + '_API_BASE') && env(p + '_API_TOKEN')), hint: 'اختياري إذا كنت تدخل المنتجات يدوياً', optional: true },
      { key: 'tsa', label: 'الإيداع التلقائي (TSA)', ok: has('TSA_API_KEY'), hint: 'TSA_API_KEY', optional: true },
      { key: 'telegram', label: 'بوت تلغرام', ok: has('TELEGRAM_BOT_TOKEN'), hint: 'TELEGRAM_BOT_TOKEN', optional: true }
    ];
  }
  function dashboard() {
    const d = store.get();
    const byStatus = Object.fromEntries(ORDER_STATUSES.map(s => [s, 0]));
    let revenueUSD = 0, todayOrders = 0; const today = new Date().toISOString().slice(0, 10);
    for (const o of d.orders) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      if (o.status === 'completed' && o.currency === 'USD') revenueUSD += o.total;
      if (String(o.createdAt).startsWith(today)) todayOrders++;
    }
    const cats = {}; for (const p of d.products) cats[p.category] = (cats[p.category] || 0) + 1;
    const days = [];
    for (let i = 6; i >= 0; i--) { const k = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push({ day: k, orders: d.orders.filter(o => String(o.createdAt).startsWith(k)).length }); }
    return {
      products: { total: d.products.length, active: d.products.filter(p => p.active).length, manual: d.products.filter(p => p.source === 'manual').length, provider: d.products.filter(p => p.source === 'provider').length, hidden: d.products.filter(p => !p.active).length, noImage: d.products.filter(p => !p.image).length, zeroPrice: d.products.filter(p => p.active && !(p.price > 0)).length, byCategory: cats },
      orders: { total: d.orders.length, today: todayOrders, byStatus, revenueUSD: Math.round(revenueUSD * 100) / 100, last7: days },
      checks: systemChecks(), maintenance: d.settings.maintenance.enabled, ordersMode: d.settings.orders.mode, uptime: Math.round(process.uptime())
    };
  }

  // ---------- رفع الصور ----------
  function sniff(buf) {
    if (buf.length > 12 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
    return null;
  }

  // ---------- الموجّه الرئيسي ----------
  async function handle(req, res, u) {
    const p = u.pathname;
    if (!p.startsWith('/api/admin/')) return false;
    try {
      if (!csrfOk(req)) { json(res, 403, { error: 'طلب مرفوض' }); return true; }
      const method = req.method;

      if (p === '/api/admin/auth') {
        if (method === 'GET') { const s = getSession(req); json(res, 200, { session: s ? safeUser(s) : null }); return true; }
        const body = await readJson(req, 20000);
        if (body.action === 'logout') { const t = parseCookie(req, COOKIE); const s = t && sessions.get(t); if (s) audit(s, 'logout', '', req); if (t) sessions.delete(t); clearCookie(res, req); json(res, 200, { ok: true }); return true; }
        const out = login(body, req);
        if (out.error) { json(res, out.status, { error: out.error, deviceId: out.deviceId }); return true; }
        setCookie(res, req, out.token); json(res, 200, { session: safeUser(out.session) }); return true;
      }

      const s = getSession(req);
      if (!s) { json(res, 401, { error: 'انتهت الجلسة، سجّل الدخول من جديد' }); return true; }
      const need = (perm) => { if (can(s, perm)) return true; json(res, 403, { error: 'ليس لديك صلاحية لهذه العملية' }); return false; };
      const fail = (code, msg, extra) => { json(res, code, { error: msg, ...(extra || {}) }); return true; };

      if (p === '/api/admin/meta' && method === 'GET') { json(res, 200, { categories: CATEGORIES.map(([key, name]) => ({ key, name })), currencies: CURRENCIES, orderStatuses: ORDER_STATUSES, role: s.role, perms: s.role === 'main' ? ['*'] : [...SUPPORT_PERMS], supabase: supaConfigured(), maxSupportDevices }); return true; }

      if (p === '/api/admin/dashboard' && method === 'GET') { if (!need('dashboard')) return true; json(res, 200, dashboard()); return true; }

      // ---- المنتجات ----
      if (p === '/api/admin/products' && method === 'GET') {
        if (!need('products.read')) return true;
        const q = clip(u.searchParams.get('q'), 100).toLowerCase(), cat = u.searchParams.get('category'), act = u.searchParams.get('active'), src = u.searchParams.get('source');
        let arr = store.get().products.filter(x => (!q || x.name.toLowerCase().includes(q) || (x.gameName || '').toLowerCase().includes(q)) && (!cat || x.category === cat) && (act === null || act === '' || String(x.active) === act) && (!src || x.source === src));
        arr = arr.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        const pg = paginate(arr, u, 25); json(res, 200, { ...pg, items: pg.items.map(adminProduct), margin: margin() }); return true;
      }
      if (p === '/api/admin/products' && method === 'POST') {
        if (!need('products.write')) return true;
        const body = await readJson(req, 200000);
        const r = cleanProduct(body, null); if (r.error) return fail(400, r.error);
        const dup = store.get().products.find(x => x.key === r.product.key); if (dup) return fail(409, 'يوجد منتج بنفس الاسم في هذا القسم');
        store.mutate(d => { d.products.push(r.product); });
        audit(s, 'product.create', `${r.product.name} (${r.product.category})`, req); json(res, 201, { product: adminProduct(r.product) }); return true;
      }
      if (p === '/api/admin/products/export' && method === 'GET') {
        if (!need('products.read')) return true;
        const list = store.get().products; const fmt = u.searchParams.get('format');
        if (fmt === 'csv') {
          const csv = '\uFEFF' + CSV_COLS.join(',') + '\n' + list.map(x => CSV_COLS.map(c => csvEscape(c === 'active' ? (x.active ? 'true' : 'false') : x[c])).join(',')).join('\n');
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="products.csv"', 'Cache-Control': 'no-store' }); res.end(csv); return true;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="products.json"', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(list.map(x => ({ ...x, providers: undefined })), null, 2)); return true;
      }
      if (p === '/api/admin/products/import' && method === 'POST') {
        if (!need('products.write')) return true;
        const body = await readJson(req, 4e6);
        const mode = body.mode === 'replace' ? 'replace' : 'merge';
        if (mode === 'replace' && s.role !== 'main') return fail(403, 'الاستبدال الكامل للإدارة الرئيسية فقط');
        let rows;
        try {
          if (body.format === 'csv') {
            const t = parseCsv(body.data || ''); if (t.length < 2) return fail(400, 'ملف CSV فارغ أو بلا صفوف');
            const head = t[0].map(h => h.trim());
            if (!head.includes('name') || !head.includes('category') || !head.includes('price')) return fail(400, 'يجب أن يحتوي الصف الأول على الأعمدة: name, category, price');
            rows = t.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
          } else { rows = typeof body.data === 'string' ? JSON.parse(body.data) : body.data; if (!Array.isArray(rows)) return fail(400, 'JSON يجب أن يكون مصفوفة منتجات'); }
        } catch { return fail(400, 'تعذر قراءة البيانات. تأكد من الصيغة.'); }
        const r = importProducts(rows, mode); if (r.error) return fail(400, r.error);
        audit(s, 'product.import', `${mode}: +${r.created} ~${r.updated} ✗${r.skipped}`, req); json(res, 200, r); return true;
      }
      if (p === '/api/admin/products/bulk' && method === 'POST') {
        if (!need('products.write')) return true;
        const b = await readJson(req, 300000); const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 5000) : [];
        if (!ids.length) return fail(400, 'اختر منتجاً واحداً على الأقل');
        const set = new Set(ids); let n = 0;
        if (b.action === 'delete' && s.role !== 'main') return fail(403, 'الحذف للإدارة الرئيسية فقط');
        if (b.action === 'reprice' && s.role !== 'main') return fail(403, 'تعديل الأسعار الجماعي للإدارة الرئيسية فقط');
        if (b.action === 'category' && !CAT_KEYS.has(b.value)) return fail(400, 'القسم غير صحيح');
        let m = margin(); if (b.action === 'reprice') { m = Number(b.value); if (!(Number.isFinite(m) && m >= 0 && m <= 500)) return fail(400, 'نسبة الربح غير صحيحة'); }
        if (!['activate', 'deactivate', 'delete', 'reprice', 'category'].includes(b.action)) return fail(400, 'إجراء غير معروف');
        store.mutate(d => {
          if (b.action === 'delete') { const before = d.products.length; d.products = d.products.filter(x => !set.has(x.id)); n = before - d.products.length; return; }
          for (const x of d.products) if (set.has(x.id)) {
            if (b.action === 'activate') x.active = true;
            else if (b.action === 'deactivate') x.active = false;
            else if (b.action === 'category') { x.category = b.value; x.key = `${x.category}|${cleanName(x.name)}`; }
            else if (b.action === 'reprice') { if (x.cost !== null && x.cost !== undefined) { x.price = calcPrice(x.cost, m); x.autoPrice = true; } else continue; }
            x.updatedAt = now(); n++;
          }
        });
        audit(s, 'product.bulk.' + b.action, `${n} منتج`, req); json(res, 200, { ok: true, affected: n }); return true;
      }
      if (p === '/api/admin/products/sync' && method === 'POST') {
        if (!need('products.sync')) return true;
        const r = await syncFromProviders(); if (r.error) return fail(502, r.error, { diagnostics: r.diagnostics });
        audit(s, 'product.sync', `+${r.created} ~${r.updated}`, req); json(res, 200, r); return true;
      }
      const pm = p.match(/^\/api\/admin\/products\/([A-Za-z0-9_.:-]{1,80})$/);
      if (pm) {
        const id = pm[1];
        const ex = store.get().products.find(x => x.id === id); if (!ex) return fail(404, 'المنتج غير موجود');
        if (method === 'PUT') {
          if (!need('products.write')) return true;
          const body = await readJson(req, 200000); const r = cleanProduct(body, ex); if (r.error) return fail(400, r.error);
          const dup = store.get().products.find(x => x.key === r.product.key && x.id !== id); if (dup) return fail(409, 'يوجد منتج آخر بنفس الاسم في هذا القسم');
          store.mutate(() => { Object.assign(ex, r.product); });
          audit(s, 'product.update', `${ex.name}`, req); json(res, 200, { product: adminProduct(ex) }); return true;
        }
        if (method === 'DELETE') {
          if (!need('products.delete')) return true;
          store.mutate(d => { d.products = d.products.filter(x => x.id !== id); });
          audit(s, 'product.delete', ex.name, req); json(res, 200, { ok: true }); return true;
        }
      }

      // ---- الطلبات ----
      if (p === '/api/admin/orders' && method === 'GET') {
        if (!need('orders.read')) return true;
        const q = clip(u.searchParams.get('q'), 100).toLowerCase(), st = u.searchParams.get('status');
        let arr = store.get().orders.filter(o => (!st || o.status === st) && (!q || o.id.toLowerCase().includes(q) || (o.userEmail || '').toLowerCase().includes(q) || o.productName.toLowerCase().includes(q)));
        arr = arr.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        json(res, 200, paginate(arr, u, 25)); return true;
      }
      const om = p.match(/^\/api\/admin\/orders\/(ORD-[A-Z0-9]{4,30})(\/execute)?$/);
      if (om) {
        const o = store.get().orders.find(x => x.id === om[1]); if (!o) return fail(404, 'الطلب غير موجود');
        if (om[2] && method === 'POST') {
          if (!need('orders.execute')) return true;
          if (o.execution !== 'provider') return fail(400, 'هذا الطلب ليس مرتبطاً بمزوّد؛ نفّذه يدوياً ثم غيّر حالته.');
          if (o.providerRef && o.status === 'processing') return fail(409, 'أُرسل هذا الطلب للمزوّد سابقاً.');
          if (['completed', 'rejected', 'cancelled'].includes(o.status)) return fail(409, 'لا يمكن تنفيذ طلب منتهٍ.');
          const r = await runExecution(o.id, s.username); audit(s, 'order.execute', `${o.id}: ${r.error || 'ok'}`, req);
          if (r.error) return fail(502, r.error, { order: o }); json(res, 200, { ok: true, order: o }); return true;
        }
        if (method === 'PATCH') {
          if (!need('orders.write')) return true;
          const b = await readJson(req, 20000);
          if (b.status !== undefined && !ORDER_STATUSES.includes(b.status)) return fail(400, 'حالة غير صحيحة');
          store.mutate(() => {
            if (b.status !== undefined && b.status !== o.status) { pushHistory(o, s.username, b.status, b.note); o.status = b.status; }
            else if (b.note) pushHistory(o, s.username, o.status, b.note);
            if (b.note !== undefined) o.note = clip(b.note, 300);
            o.updatedAt = now();
          });
          audit(s, 'order.update', `${o.id} → ${o.status}`, req); json(res, 200, { order: o }); return true;
        }
      }

      // ---- المستخدمون ----
      if (p === '/api/admin/users' && method === 'GET') {
        if (!need('users.read')) return true;
        if (!supaConfigured()) { json(res, 200, { configured: false, users: [] }); return true; }
        const page = Math.max(1, parseInt(u.searchParams.get('page')) || 1), q = clip(u.searchParams.get('q'), 100).toLowerCase();
        const r = await supaAdmin(`/auth/v1/admin/users?page=${page}&per_page=100`);
        if (!r.ok) return fail(502, `تعذر جلب المستخدمين من Supabase (HTTP ${r.status})`);
        const d = await r.json(); let users = (d.users || []).map(x => ({ id: x.id, email: x.email || '', created_at: x.created_at, last_sign_in_at: x.last_sign_in_at, confirmed: !!x.email_confirmed_at, banned: !!(x.banned_until && new Date(x.banned_until) > new Date()), provider: x.app_metadata?.provider || '' }));
        if (q) users = users.filter(x => x.email.toLowerCase().includes(q) || x.id.includes(q));
        json(res, 200, { configured: true, users, page, total: d.total ?? null, hasMore: (d.users || []).length === 100 }); return true;
      }
      const um = p.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/ban$/i);
      if (um && method === 'POST') {
        if (s.role !== 'main') return fail(403, 'إيقاف الحسابات للإدارة الرئيسية فقط');
        if (!UUID.test(um[1])) return fail(400, 'معرّف غير صحيح');
        if (!supaConfigured()) return fail(503, 'Supabase غير مضبوط');
        const b = await readJson(req, 5000);
        const r = await supaAdmin(`/auth/v1/admin/users/${um[1]}`, { method: 'PUT', body: JSON.stringify({ ban_duration: b.ban ? '876000h' : 'none' }) });
        if (!r.ok) return fail(502, `فشل التنفيذ (HTTP ${r.status})`);
        audit(s, b.ban ? 'user.ban' : 'user.unban', um[1], req); json(res, 200, { ok: true }); return true;
      }

      // ---- الإيداعات (مالي: الإدارة الرئيسية فقط) ----
      if (p === '/api/admin/deposits' && method === 'GET') {
        if (s.role !== 'main') return fail(403, 'القسم المالي للإدارة الرئيسية فقط');
        if (!supaConfigured()) { json(res, 200, { configured: false, items: [] }); return true; }
        const r = await supaAdmin('/rest/v1/qc_auto_deposit_claims?select=*&order=created_at.desc&limit=200');
        if (!r.ok) return fail(502, r.status === 404 ? 'جدول الإيداعات غير موجود. شغّل supabase_auto_deposit_tsa.sql في Supabase.' : `تعذر جلب الإيداعات (HTTP ${r.status})`);
        const items = await r.json(); const totals = {};
        for (const x of items) totals[x.currency] = Math.round(((totals[x.currency] || 0) + Number(x.amount)) * 1e8) / 1e8;
        json(res, 200, { configured: true, items, totals }); return true;
      }

      // ---- الإعدادات ----
      if (p === '/api/admin/settings') {
        if (!need('settings.read')) return true;
        if (method === 'GET') { json(res, 200, { settings: store.get().settings, forcedEnv: String(process.env.FORCED_CHANNELS_REQUIRED || 'false').toLowerCase() === 'true' }); return true; }
        if (method === 'PUT') {
          if (s.role !== 'main') return fail(403, 'تعديل الإعدادات للإدارة الرئيسية فقط');
          const body = await readJson(req, 300000);
          const r = cleanSettings(body, store.get().settings); if (r.error) return fail(400, r.error);
          const changed = Object.keys(body);
          store.mutate(d => { d.settings = r.settings; });
          audit(s, 'settings.update', changed.join(','), req); json(res, 200, { settings: store.get().settings }); return true;
        }
      }
      if (p === '/api/admin/upload' && method === 'POST') {
        if (!need('upload')) return true;
        const b = await readJson(req, 4.2e6);
        const m = String(b.data || '').match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) return fail(400, 'الصورة يجب أن تكون PNG أو JPG أو WEBP');
        const buf = Buffer.from(m[1], 'base64'); if (buf.length > 3 * 1024 * 1024) return fail(413, 'الحد الأقصى لحجم الصورة 3MB');
        const ext = sniff(buf); if (!ext) return fail(400, 'ملف الصورة غير صالح');
        const dir = path.join(publicDir, 'uploads'); fs.mkdirSync(dir, { recursive: true });
        const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(dir, name), buf);
        audit(s, 'upload', name, req); json(res, 201, { url: `/uploads/${name}` }); return true;
      }

      // ---- المزودون ----
      if (p === '/api/admin/providers' && method === 'GET') {
        if (!need('providers.read')) return true;
        const refresh = u.searchParams.get('check') === '1';
        if (refresh) await liveCatalog(true);
        const st = ctx.productStatus ? ctx.productStatus() : { providers: [] };
        json(res, 200, { providers: st.providers, checkedAt: st.at ? new Date(st.at).toISOString() : null }); return true;
      }

      // ---- الأجهزة (للدعم) ----
      if (p === '/api/admin/devices') {
        if (s.role !== 'main') return fail(403, 'إدارة الأجهزة للإدارة الرئيسية فقط');
        if (method === 'GET') { json(res, 200, { max: maxSupportDevices, devices: store.get().devices }); return true; }
        if (method === 'POST') {
          const b = await readJson(req, 5000); const id = clip(b.device_id, 120);
          if (id.length < 16) return fail(400, 'معرّف الجهاز غير صالح');
          if (b.action === 'approve') {
            const r = store.mutate(d => {
              let dev = d.devices.find(x => x.device_id === id);
              if (!dev) dev = d.devices[d.devices.push({ device_id: id, username: USERS.support.username, label: '', approved: false, created_at: now() }) - 1];
              if (!dev.approved && d.devices.filter(x => x.approved && x.username === dev.username).length >= maxSupportDevices) return { error: `الحد الأقصى ${maxSupportDevices} أجهزة. ألغِ جهازاً أولاً.` };
              dev.approved = true; dev.label = clip(b.label, 60) || dev.label || 'جهاز الدعم'; return {};
            });
            if (r.error) return fail(400, r.error); audit(s, 'device.approve', id.slice(0, 8), req); json(res, 200, { ok: true }); return true;
          }
          if (b.action === 'revoke') { store.mutate(d => { d.devices = d.devices.filter(x => x.device_id !== id); for (const [t, ss] of sessions) if (ss.deviceId === id) sessions.delete(t); }); audit(s, 'device.revoke', id.slice(0, 8), req); json(res, 200, { ok: true }); return true; }
          return fail(400, 'إجراء غير معروف');
        }
      }

      // ---- سجل النشاط ----
      if (p === '/api/admin/audit' && method === 'GET') {
        if (s.role !== 'main') return fail(403, 'سجل النشاط للإدارة الرئيسية فقط');
        const q = clip(u.searchParams.get('q'), 80).toLowerCase();
        const arr = store.get().audit.filter(a => !q || a.action.toLowerCase().includes(q) || a.user.toLowerCase().includes(q) || (a.detail || '').toLowerCase().includes(q)).slice().reverse();
        json(res, 200, paginate(arr, u, 50)); return true;
      }

      return fail(404, 'المسار غير موجود');
    } catch (e) {
      const st = e.status || 500;
      if (st === 500) console.warn('[admin] error:', e.message);
      json(res, st, { error: st === 500 ? 'خطأ داخلي في الخادم' : e.message });
      return true;
    }
  }

  return { handle, getSession, publicSettings, publicProducts, createOrder, publicOrder, syncFromProviders, CATEGORIES, CAT_KEYS };
}

module.exports = createAdmin;
