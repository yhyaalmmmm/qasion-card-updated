// تخزين دائم بسيط (ملف JSON) — كتابة ذرّية + نسخة احتياطية تلقائية.
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'store.json');
const BAK = path.join(DIR, 'store.bak.json');

function defaults() {
  return {
    v: 1,
    settings: {
      siteName: 'QASION CARD',
      siteDescription: 'شحن الألعاب والتطبيقات والبطاقات الإلكترونية',
      support: { telegram: '', whatsapp: '', youtube: '', email: '' },
      maintenance: { enabled: false, message: 'الموقع تحت الصيانة حالياً، نعود قريباً.' },
      announcement: { enabled: false, text: '' },
      profitMargin: 3,
      orders: { mode: 'review' }, // review = كل طلب ينتظر موافقة الإدارة | auto = تنفيذ تلقائي للمنتجات المرتبطة بمزوّد
      forcedChannels: { required: null }, // null = اتبع ملف .env
      banners: [
        { id: 'b1', title: 'قاسيون كارد', image: '/assets/banner-1.jpg', mobile: '/assets/banner-1-mobile.jpg', link: '', active: true, sort: 1 },
        { id: 'b2', title: 'أهلاً بكم في قاسيون كارد', image: '/assets/banner-2.jpg', mobile: '/assets/banner-2-mobile.jpg', link: '', active: true, sort: 2 },
        { id: 'b3', title: 'شحن ألعاب وتطبيقات وبطاقات', image: '/assets/banner-3.jpg', mobile: '/assets/banner-3-mobile.jpg', link: '', active: true, sort: 3 }
      ]
    },
    products: [],
    orders: [],
    devices: [],
    audit: []
  };
}

let data = null;

function load() {
  if (data) return data;
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of [FILE, BAK]) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      data = merge(defaults(), raw);
      return data;
    } catch (e) {
      if (e.code !== 'ENOENT' && f === FILE) {
        try { fs.renameSync(FILE, path.join(DIR, `store.corrupt-${Date.now()}.json`)); } catch {}
      }
    }
  }
  data = defaults();
  save();
  return data;
}

function merge(base, raw) {
  const out = { ...base, ...raw };
  out.settings = {
    ...base.settings, ...(raw.settings || {}),
    support: { ...base.settings.support, ...(raw.settings?.support || {}) },
    maintenance: { ...base.settings.maintenance, ...(raw.settings?.maintenance || {}) },
    announcement: { ...base.settings.announcement, ...(raw.settings?.announcement || {}) },
    orders: { ...base.settings.orders, ...(raw.settings?.orders || {}) },
    forcedChannels: { ...base.settings.forcedChannels, ...(raw.settings?.forcedChannels || {}) },
    banners: Array.isArray(raw.settings?.banners) ? raw.settings.banners : base.settings.banners
  };
  for (const k of ['products', 'orders', 'devices', 'audit']) if (!Array.isArray(out[k])) out[k] = [];
  return out;
}

function save() {
  if (!data) return;
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  try { if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK); } catch {}
  fs.renameSync(tmp, FILE);
}

function get() { return load(); }
function mutate(fn) { const d = load(); const r = fn(d); save(); return r; }

module.exports = { get, mutate, save, FILE, DIR };
