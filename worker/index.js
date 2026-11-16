// AevyCPM API - Cloudflare Worker (D1 database + private R2 bucket)
// Bindings: DB (D1), FILES (R2). Secrets: ADMIN_PASSWORD, SESSION_SECRET, TURNSTILE_SECRET (optional).

const MB = 1048576;
const TEXT_EXT = ['lua', 'luau', 'js', 'mjs', 'ts', 'txt', 'json', 'py', 'sh', 'md', 'c', 'cpp', 'h', 'cs', 'java',
  'go', 'rs', 'php', 'rb', 'ahk', 'css', 'html', 'xml', 'yaml', 'yml', 'ini', 'cfg'];
const ALLOWED_EXT = [...TEXT_EXT, 'zip'];
const BLOCKED_IN_ZIP = /\.(exe|dll|msi|scr|com|pif|cpl|sys|drv)$/i;
const REASONS = ['malicious', 'spam', 'copyright', 'inappropriate', 'other'];
const STATUSES = ['pending', 'approved', 'rejected'];
const PREVIEW_MAX = 200000;
const PUB_COLS = 'id,title,description,category,tags,version,author,filename,file_type,file_size,sha256,downloads,status,created_at,updated_at';
const ADMIN_COLS = PUB_COLS + ',reject_reason';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m, s = 400) => new HttpError(s, m);
const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), {
  status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', ...h },
});
const now = () => Date.now();
const enc = new TextEncoder();
const maxBytes = (env) => Math.round((parseFloat(env.MAX_UPLOAD_MB) || 5) * MB);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

/* ---------- crypto helpers ---------- */
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newId() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => abc[b % abc.length]).join('');
}
const ipHash = async (req, env) => (await hmac(env.SESSION_SECRET, 'ip:' + (req.headers.get('CF-Connecting-IP') || '0'))).slice(0, 22);

/* ---------- rate limiting (D1 backed, free-plan friendly) ---------- */
async function hit(env, key, windowSec) {
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits(key,count,reset_at) VALUES(?1,1,?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING count`).bind(key, t + windowSec * 1000, t).first();
  return r.count;
}
async function limit(env, key, max, windowSec, msg) {
  const c = await hit(env, key, windowSec);
  if (c > max) throw bad(msg || 'Too many requests. Please try again later.', 429);
  return c;
}

/* ---------- admin auth (HMAC-signed, expiring bearer token) ---------- */
async function requireAdmin(req, env, soft = false) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [exp, sig] = t.split('.');
  const ok = exp && sig && +exp > now() && safeEq(sig, await hmac(env.SESSION_SECRET, 'admin:' + exp));
  if (!ok && !soft) throw bad('Admin authentication required', 401);
  return !!ok;
}
async function adminLogin(req, env) {
  const ip = await ipHash(req, env);
  await limit(env, `login:${ip}`, 6, 900, 'Too many login attempts. Try again in 15 minutes.');
  const b = await req.json().catch(() => ({}));
  const ok = safeEq(await hmac(env.SESSION_SECRET, 'pw:' + String(b.password || '')),
                    await hmac(env.SESSION_SECRET, 'pw:' + env.ADMIN_PASSWORD));
  if (!ok) throw bad('Incorrect password', 401);
  const exp = now() + 8 * 3600e3;
  return json({ token: `${exp}.${await hmac(env.SESSION_SECRET, 'admin:' + exp)}`, expires: exp });
}

/* ---------- Turnstile (optional) ---------- */
async function turnstile(env, token, req) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) throw bad('Complete the human check and try again');
  const fd = new FormData();
  fd.append('secret', env.TURNSTILE_SECRET);
  fd.append('response', token);
  fd.append('remoteip', req.headers.get('CF-Connecting-IP') || '');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: fd });
  if (!(await r.json()).success) throw bad('Human check failed. Reload and try again.');
}

/* ---------- ZIP inspection (central directory only, nothing is extracted) ---------- */
function zipInfo(buf) {
  const v = new DataView(buf), n = buf.byteLength;
  if (n < 22 || v.getUint32(0, true) !== 0x04034b50) throw bad('Not a valid ZIP file');
  let e = -1;
  for (let i = n - 22; i >= Math.max(0, n - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw bad('ZIP file is corrupted');
  const count = v.getUint16(e + 10, true);
  if (count > 2000) throw bad('ZIP contains too many files (max 2000)');
  let off = v.getUint32(e + 16, true), total = 0;
  const names = [], dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (off + 46 > n || v.getUint32(off, true) !== 0x02014b50) throw bad('ZIP file is corrupted');
    const nl = v.getUint16(off + 28, true), xl = v.getUint16(off + 30, true), cl = v.getUint16(off + 32, true);
    if (off + 46 + nl > n) throw bad('ZIP file is corrupted');
    total += v.getUint32(off + 24, true);
    const name = dec.decode(new Uint8Array(buf, off + 46, nl));
    if (/(^|[\\/])\.\.([\\/]|$)/.test(name) || /^([\\/]|[a-z]:)/i.test(name)) throw bad('ZIP contains unsafe paths');
    if (BLOCKED_IN_ZIP.test(name)) throw bad('ZIP contains blocked executable files (.exe, .dll, ...)');
    names.push(name);
    off += 46 + nl + xl + cl;
  }
  if (total > 50 * MB) throw bad('ZIP expands to more than 50 MB');
  return { names, total };
}

/* ---------- routing ---------- */
export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) throw new HttpError(500, 'Server is not configured: set ADMIN_PASSWORD and SESSION_SECRET');
      res = await route(req, env, new URL(req.url));
    } catch (e) {
      if (e instanceof HttpError) res = json({ error: e.message }, e.status);
      else { console.error(e); res = json({ error: 'Internal error' }, 500); }
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries({
      ...cors, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    })) h.set(k, v);
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers: h });
  },
};

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET,POST,PATCH,PUT,DELETE,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

async function route(req, env, url) {
  const m = req.method, p = url.pathname.replace(/\/+$/, '');
  if (p === '/api/scripts' && m === 'GET') return queryScripts(env, url, false);
  if (p === '/api/scripts' && m === 'POST') return createScript(req, env);
  if (p === '/api/categories' && m === 'GET') return listCategories(env);
  if (p === '/api/stats' && m === 'GET') return publicStats(env);
  if (p === '/api/admin/login' && m === 'POST') return adminLogin(req, env);
  let r = p.match(/^\/api\/scripts\/([a-z0-9]{6,12})(?:\/(preview|download-link|download|report))?$/);
  if (r) {
    const [, id, sub] = r;
    if (!sub && m === 'GET') return getScript(req, env, id);
    if (sub === 'preview' && m === 'GET') return previewScript(req, env, id);
    if (sub === 'download-link' && m === 'POST') return downloadLink(req, env, id);
    if (sub === 'download' && m === 'GET') return download(req, env, id, url);
    if (sub === 'report' && m === 'POST') return report(req, env, id);
  }
  if (p.startsWith('/api/admin/')) { await requireAdmin(req, env); return adminRoute(req, env, url, p, m); }
  throw bad('Not found', 404);
}

/* ---------- public endpoints ---------- */
async function listCategories(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.slug, c.name, (SELECT COUNT(*) FROM scripts s WHERE s.category = c.slug AND s.status = 'approved') AS count
     FROM categories c ORDER BY c.name`).all();
  return json({ categories: results, limits: { maxBytes: maxBytes(env), extensions: ALLOWED_EXT } });
}

async function publicStats(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS scripts, COALESCE(SUM(downloads),0) AS downloads FROM scripts WHERE status='approved'`).first();
  return json(r);
}

async function queryScripts(env, url, admin) {
  const sp = url.searchParams, w = [], p = [];
  const status = admin ? sp.get('status') : 'approved';
  if (STATUSES.includes(status)) { w.push('status=?'); p.push(status); }
  const cat = clean(sp.get('category'), 32);
  if (cat) { w.push('category=?'); p.push(cat); }
  const tag = clean(sp.get('tag'), 24).toLowerCase();
  if (tag) { w.push(`(',' || tags || ',') LIKE ? ESCAPE '\\'`); p.push(`%,${tag.replace(/[\\%_]/g, '\\$&')},%`); }
  const q = clean(sp.get('q'), 80);
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    w.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\')`);
    p.push(like, like, like, like);
  }
  const order = { popular: 'downloads DESC, created_at DESC', title: 'title COLLATE NOCASE ASC' }[sp.get('sort')] || 'created_at DESC';
  const per = Math.min(50, Math.max(1, +sp.get('per') || 20)), page = Math.max(1, +sp.get('page') || 1);
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  const [c, r] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM scripts ${where}`).bind(...p),
    env.DB.prepare(`SELECT ${admin ? ADMIN_COLS : PUB_COLS} FROM scripts ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...p, per, (page - 1) * per),
  ]);
  return json({ items: r.results, total: c.results[0].n, page, per });
}

async function loadScript(req, env, id, extra = '') {
  const admin = await requireAdmin(req, env, true);
  const s = await env.DB.prepare(`SELECT ${ADMIN_COLS},file_key,entries${extra} FROM scripts WHERE id=?`).bind(id).first();
  if (!s || (s.status !== 'approved' && !admin)) throw bad('Script not found', 404);
  return { s, admin };
}

async function getScript(req, env, id) {
  const { s, admin } = await loadScript(req, env, id);
  const { file_key, entries, ...pub } = s;
  if (!admin) delete pub.reject_reason;
  return json(pub);
}

async function previewScript(req, env, id) {
  const { s } = await loadScript(req, env, id);
  if (s.file_type === 'zip') return json({ kind: 'zip', entries: JSON.parse(s.entries || '[]') });
  const obj = await env.FILES.get(s.file_key, { range: { offset: 0, length: PREVIEW_MAX } });
  if (!obj) throw bad('File missing from storage', 404);
  return json({ kind: 'text', text: new TextDecoder().decode(await obj.arrayBuffer()), truncated: s.file_size > PREVIEW_MAX });
}

// Download links are short-lived, signed URLs. The R2 bucket itself is never public.
async function downloadLink(req, env, id) {
  const ip = await ipHash(req, env);
  await limit(env, `dlink:${ip}`, 60, 60, 'Too many download requests. Slow down.');
  const { admin } = await loadScript(req, env, id);
  const exp = now() + 10 * 60e3, a = admin ? 1 : 0;
  const sig = await hmac(env.SESSION_SECRET, `dl:${id}:${exp}:${a}`);
  return json({ url: `/api/scripts/${id}/download?e=${exp}&a=${a}&s=${sig}`, expires: exp });
}

async function download(req, env, id, url) {
  const e = url.searchParams.get('e') || '', a = url.searchParams.get('a') === '1' ? 1 : 0, sig = url.searchParams.get('s') || '';
  if (!(+e > now()) || !safeEq(sig, await hmac(env.SESSION_SECRET, `dl:${id}:${e}:${a}`))) throw bad('Download link expired. Go back and click Download again.', 403);
  const ip = await ipHash(req, env);
  await limit(env, `dl:${ip}`, 60, 60, 'Too many downloads. Slow down.');
  const s = await env.DB.prepare('SELECT file_key,filename,status FROM scripts WHERE id=?').bind(id).first();
  if (!s || (!a && s.status !== 'approved')) throw bad('Script not found', 404);
  const obj = await env.FILES.get(s.file_key);
  if (!obj) throw bad('File missing from storage', 404);
  if (!a && (await hit(env, `dlc:${id}:${ip}`, 86400)) === 1) {       // count once per visitor per day
    await env.DB.batch([
      env.DB.prepare('UPDATE scripts SET downloads = downloads + 1 WHERE id=?').bind(id),
      env.DB.prepare(`INSERT INTO daily_stats(day,uploads,downloads) VALUES(?,0,1) ON CONFLICT(day) DO UPDATE SET downloads = downloads + 1`).bind(new Date().toISOString().slice(0, 10)),
    ]);
  }
  return new Response(obj.body, { headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${s.filename.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(s.filename)}`,
    'Content-Length': String(obj.size), 'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

async function report(req, env, id) {
  const ip = await ipHash(req, env);
  await limit(env, `rep:${ip}`, 5, 3600, 'Report limit reached. Try again later.');
  const b = await req.json().catch(() => ({}));
  if (!REASONS.includes(b.reason)) throw bad('Choose a valid reason');
  const s = await env.DB.prepare(`SELECT id FROM scripts WHERE id=? AND status='approved'`).bind(id).first();
  if (!s) throw bad('Script not found', 404);
  const dup = await env.DB.prepare(`SELECT 1 FROM reports WHERE script_id=? AND ip_hash=? AND status='open'`).bind(id, ip).first();
  if (!dup) await env.DB.prepare('INSERT INTO reports(script_id,reason,details,ip_hash,created_at) VALUES(?,?,?,?,?)')
    .bind(id, b.reason, clean(b.details, 500) || null, ip, now()).run();
  return json({ ok: true });
}

async function createScript(req, env) {
  const max = maxBytes(env), ip = await ipHash(req, env);
  if ((+req.headers.get('content-length') || 0) > max + 256 * 1024) throw bad(`File exceeds the ${max / MB} MB limit`, 413);
  if (!/multipart\/form-data/i.test(req.headers.get('content-type') || '')) throw bad('Expected multipart form data', 415);
  await limit(env, `up:h:${ip}`, 8, 3600, 'Upload limit reached (8 per hour). Try again later.');
  await limit(env, `up:d:${ip}`, 30, 86400, 'Daily upload limit reached.');
  const f = await req.formData();

  if (f.get('website')) throw bad('Rejected as spam');                       // honeypot
  const ts = +f.get('ts') || 0;
  if (!ts || now() - ts < 3000) throw bad('Form submitted too quickly. Please try again.');
  await turnstile(env, f.get('cf-turnstile-response'), req);

  const title = clean(f.get('title'), 80);
  if (title.length < 3) throw bad('Title must be at least 3 characters');
  const description = clean(f.get('description'), 2000);
  if (description.length < 10) throw bad('Description must be at least 10 characters');
  if ((description.match(/https?:\/\//gi) || []).length > 3) throw bad('Description contains too many links');
  const author = clean(f.get('author'), 32) || 'Anonymous';
  if (/https?:|www\./i.test(author)) throw bad('Author name cannot contain links');
  const version = clean(f.get('version'), 20) || '1.0.0';
  if (!/^[\w.+-]+$/.test(version)) throw bad('Version can only contain letters, numbers, dots and dashes');
  const category = clean(f.get('category'), 32);
  if (!(await env.DB.prepare('SELECT 1 FROM categories WHERE slug=?').bind(category).first())) throw bad('Choose a category');
  const tags = [...new Set(clean(f.get('tags'), 200).toLowerCase().split(/[,\s]+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, '')).filter((t) => t.length >= 2 && t.length <= 24))].slice(0, 6).join(',');

  const file = f.get('file');
  if (!file || typeof file === 'string' || !file.size) throw bad('Choose a file to upload');
  if (file.size > max) throw bad(`File exceeds the ${max / MB} MB limit`, 413);
  const name = file.name.split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(-100) || 'script.txt';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!ALLOWED_EXT.includes(ext)) throw bad(`File type not allowed. Use: ${ALLOWED_EXT.join(', ')}`);

  const buf = await file.arrayBuffer();
  let entries = null;
  if (ext === 'zip') entries = JSON.stringify(zipInfo(buf).names.slice(0, 500));
  else {
    if (new Uint8Array(buf).includes(0)) throw bad('File looks binary. Upload source code as plain text.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw bad('File must be UTF-8 text'); }
  }
  const hash = await sha256(buf);
  if (await env.DB.prepare(`SELECT 1 FROM scripts WHERE sha256=? AND status != 'rejected'`).bind(hash).first())
    throw bad('This exact file has already been published', 409);

  const auto = (await env.DB.prepare(`SELECT value FROM settings WHERE key='auto_approve'`).first())?.value === 'true';
  const id = newId(), key = `scripts/${id}/${name}`, t = now();
  await env.FILES.put(key, buf, { httpMetadata: { contentType: 'application/octet-stream' } });
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO scripts(id,title,description,category,tags,version,author,filename,file_key,file_type,file_size,sha256,entries,status,ip_hash,created_at,updated_at)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, title, description, category, tags, version, author, name, key, ext, file.size, hash, entries, auto ? 'approved' : 'pending', ip, t, t),
      env.DB.prepare(`INSERT INTO daily_stats(day,uploads,downloads) VALUES(?,1,0) ON CONFLICT(day) DO UPDATE SET uploads = uploads + 1`).bind(new Date().toISOString().slice(0, 10)),
    ]);
  } catch (e) { await env.FILES.delete(key); throw e; }
  if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(t).run();
  return json({ id, status: auto ? 'approved' : 'pending' }, 201);
}

/* ---------- admin endpoints ---------- */
async function adminRoute(req, env, url, p, m) {
  if (p === '/api/admin/scripts' && m === 'GET') return queryScripts(env, url, true);
  if (p === '/api/admin/stats' && m === 'GET') return adminStats(env);
  if (p === '/api/admin/reports' && m === 'GET') return adminReports(env, url);
  if (p === '/api/admin/settings' && m === 'GET') return json({ auto_approve: (await env.DB.prepare(`SELECT value FROM settings WHERE key='auto_approve'`).first())?.value === 'true' });
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await req.json().catch(() => ({}));
    await env.DB.prepare(`INSERT INTO settings(key,value) VALUES('auto_approve',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(b.auto_approve ? 'true' : 'false').run();
    return json({ ok: true });
  }
  if (p === '/api/admin/categories' && m === 'POST') {
    const b = await req.json().catch(() => ({}));
    const name = clean(b.name, 32);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) throw bad('Enter a category name');
    const r = await env.DB.prepare('INSERT OR IGNORE INTO categories(slug,name) VALUES(?,?)').bind(slug, name).run();
    if (!r.meta.changes) throw bad('Category already exists', 409);
    return json({ slug, name }, 201);
  }
  let r = p.match(/^\/api\/admin\/categories\/([a-z0-9-]{1,40})$/);
  if (r && m === 'PATCH') {
    const name = clean((await req.json().catch(() => ({}))).name, 32);
    if (!name) throw bad('Enter a category name');
    const x = await env.DB.prepare('UPDATE categories SET name=? WHERE slug=?').bind(name, r[1]).run();
    if (!x.meta.changes) throw bad('Category not found', 404);
    return json({ ok: true });
  }
  if (r && m === 'DELETE') {
    if (r[1] === 'other') throw bad('The "Other" category cannot be deleted');
    await env.DB.batch([
      env.DB.prepare(`UPDATE scripts SET category='other' WHERE category=?`).bind(r[1]),
      env.DB.prepare('DELETE FROM categories WHERE slug=?').bind(r[1]),
    ]);
    return json({ ok: true });
  }
  r = p.match(/^\/api\/admin\/reports\/(\d+)$/);
  if (r && m === 'PATCH') {
    const st = (await req.json().catch(() => ({}))).status;
    if (!['open', 'resolved', 'dismissed'].includes(st)) throw bad('Invalid status');
    await env.DB.prepare('UPDATE reports SET status=? WHERE id=?').bind(st, +r[1]).run();
    return json({ ok: true });
  }
  r = p.match(/^\/api\/admin\/scripts\/([a-z0-9]{6,12})$/);
  if (r && m === 'PATCH') return adminPatchScript(req, env, r[1]);
  if (r && m === 'DELETE') {
    const s = await env.DB.prepare('SELECT file_key FROM scripts WHERE id=?').bind(r[1]).first();
    if (!s) throw bad('Script not found', 404);
    await env.FILES.delete(s.file_key);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reports WHERE script_id=?').bind(r[1]),
      env.DB.prepare('DELETE FROM scripts WHERE id=?').bind(r[1]),
    ]);
    return json({ ok: true });
  }
  throw bad('Not found', 404);
}

async function adminPatchScript(req, env, id) {
  const b = await req.json().catch(() => ({})), sets = [], p = [];
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) throw bad('Invalid status');
    sets.push('status=?', 'reject_reason=?');
    p.push(b.status, b.status === 'rejected' ? clean(b.reject_reason, 200) || null : null);
  }
  if (b.category !== undefined) {
    if (!(await env.DB.prepare('SELECT 1 FROM categories WHERE slug=?').bind(String(b.category)).first())) throw bad('Unknown category');
    sets.push('category=?'); p.push(String(b.category));
  }
  if (b.title !== undefined) {
    const t = clean(b.title, 80);
    if (t.length < 3) throw bad('Title must be at least 3 characters');
    sets.push('title=?'); p.push(t);
  }
  if (!sets.length) throw bad('Nothing to update');
  sets.push('updated_at=?'); p.push(now());
  const r = await env.DB.prepare(`UPDATE scripts SET ${sets.join(',')} WHERE id=?`).bind(...p, id).run();
  if (!r.meta.changes) throw bad('Script not found', 404);
  return json({ ok: true });
}

async function adminReports(env, url) {
  const st = ['open', 'resolved', 'dismissed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.script_id, r.reason, r.details, r.status, r.created_at, s.title, s.status AS script_status
     FROM reports r LEFT JOIN scripts s ON s.id = r.script_id WHERE r.status=? ORDER BY r.created_at DESC LIMIT 100`).bind(st).all();
  return json({ items: results });
}

async function adminStats(env) {
  const since = new Date(now() - 13 * 86400e3).toISOString().slice(0, 10);
  const [a, b, c, d, e] = await env.DB.batch([
    env.DB.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(downloads),0) AS downloads FROM scripts GROUP BY status'),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status='open'`),
    env.DB.prepare('SELECT day, uploads, downloads FROM daily_stats WHERE day >= ? ORDER BY day').bind(since),
    env.DB.prepare(`SELECT id, title, downloads FROM scripts WHERE status='approved' ORDER BY downloads DESC LIMIT 5`),
    env.DB.prepare('SELECT COALESCE(SUM(file_size),0) AS n FROM scripts'),
  ]);
  const by = Object.fromEntries(a.results.map((r) => [r.status, r]));
  return json({
    pending: by.pending?.n || 0, approved: by.approved?.n || 0, rejected: by.rejected?.n || 0,
    downloads: a.results.reduce((s, r) => s + r.downloads, 0), openReports: b.results[0].n,
    daily: c.results, top: d.results, storageBytes: e.results[0].n,
  });
}
