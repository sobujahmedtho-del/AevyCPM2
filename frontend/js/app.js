/* AevyCPM frontend - vanilla JS SPA (History API routing, no build step). */
(() => {
'use strict';
const CFG = window.AEVY_CONFIG || {};
const API = (CFG.API_BASE || '/api').replace(/\/$/, '');
const API_ORIGIN = new URL(API, location.origin).origin;
const TOKEN_KEY = 'aevy.admin';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = $('#app');
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const num = (n) => new Intl.NumberFormat().format(n || 0);
const loading = () => '<p class="muted">Loading…</p>';
let boot = null; // { categories, limits }

/* ---------- helpers ---------- */
const token = () => {
  const t = sessionStorage.getItem(TOKEN_KEY);
  if (t && +t.split('.')[0] < Date.now()) { sessionStorage.removeItem(TOKEN_KEY); return null; }
  return t;
};
async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}, t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(API + path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) }); }
  catch { throw new Error('Cannot reach the server. Check your connection.'); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
let toastTimer;
function toast(msg, err) {
  const el = $('#toast');
  el.textContent = msg; el.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = ''), 3500);
}
async function copy(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Copy failed. Select the text and copy manually.', true); }
}
const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
const getBoot = async () => (boot ||= await api('/categories'));
const catName = (slug) => boot?.categories.find((c) => c.slug === slug)?.name || slug;
const statusLabel = (s) => ({ approved: ['ok', 'Published'], pending: ['warn', 'Pending review'], rejected: ['bad', 'Rejected'] }[s] || ['', s]);
const errorBox = (m) => `<div class="notice error">${esc(m)}</div>`;
function setTitle(t) { document.title = t ? `${t} · AevyCPM` : 'AevyCPM'; }

/* ---------- router ---------- */
const routes = [
  [/^\/$/, home], [/^\/publish$/, publish], [/^\/s\/([a-z0-9]{6,12})$/, detail], [/^\/admin$/, admin],
];
function go(url) { history.pushState(null, '', url); render(); }
async function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  $$('.nav a').forEach((a) => a.removeAttribute('aria-current'));
  const key = path === '/' ? 'home' : path.slice(1).split('/')[0];
  $(`.nav a[data-nav="${key}"]`)?.setAttribute('aria-current', 'page');
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try { await getBoot(); await fn(...m.slice(1)); }
      catch (e) { app.innerHTML = errorBox(e.message); }
      window.scrollTo(0, 0);
      return;
    }
  }
  setTitle('Not found');
  app.innerHTML = '<div class="empty"><h2>Page not found</h2><p><a href="/">Back to all scripts</a></p></div>';
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.origin !== location.origin) return;
  e.preventDefault(); go(a.pathname + a.search);
});
addEventListener('popstate', render);
$('#theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('aevy.theme', t); } catch {}
});

/* ---------- browse ---------- */
async function home() {
  setTitle('');
  const sp = new URLSearchParams(location.search);
  const f = { q: sp.get('q') || '', category: sp.get('category') || '', tag: sp.get('tag') || '', sort: sp.get('sort') || 'new', page: sp.get('page') || '' };
  app.innerHTML = loading();
  const [cats, list, stats] = await Promise.all([api('/categories'), api('/scripts' + qs(f)), api('/stats')]);
  boot = cats;
  const pages = Math.max(1, Math.ceil(list.total / list.per));
  const link = (o) => '/' + qs({ ...f, page: '', ...o });
  app.innerHTML = `
    <div class="intro">
      <div><h1>Scripts</h1><p>Open library of Lua, JavaScript and other scripts. Publish without an account, download for free. ${num(stats.scripts)} scripts, ${num(stats.downloads)} downloads.</p></div>
      <div class="grow"></div><a class="btn btn-primary" href="/publish">Publish a script</a>
    </div>
    <div class="layout">
      <aside class="side"><h2>Categories</h2><ul>
        <li><a href="${link({ category: '' })}" aria-current="${!f.category}">All <span class="n">${num(stats.scripts)}</span></a></li>
        ${cats.categories.map((c) => `<li><a href="${link({ category: c.slug })}" aria-current="${f.category === c.slug}">${esc(c.name)} <span class="n">${c.count}</span></a></li>`).join('')}
      </ul></aside>
      <section>
        <form class="toolbar" id="search" role="search">
          <input type="search" name="q" value="${esc(f.q)}" placeholder="Search title, description, tags or author" aria-label="Search scripts" maxlength="80">
          <select name="sort" aria-label="Sort by">
            ${[['new', 'Newest'], ['popular', 'Most downloaded'], ['title', 'Name']].map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn" type="submit">Search</button>
        </form>
        ${f.tag ? `<p class="muted small" id="tagnote">Tag: <span class="label">${esc(f.tag)}</span> <a href="${link({ tag: '' })}">Clear</a></p><br>` : ''}
        <div class="box">
          <div class="box-head">${num(list.total)} ${list.total === 1 ? 'script' : 'scripts'}${f.category ? ' in ' + esc(catName(f.category)) : ''}</div>
          ${list.items.length ? `<ul class="list">${list.items.map(item).join('')}</ul>` :
            `<div class="empty"><h2>No scripts found</h2><p>Try a different search, or <a href="/publish">publish the first one</a>.</p></div>`}
        </div>
        ${pages > 1 ? `<nav class="pager" aria-label="Pagination">
          ${list.page > 1 ? `<a class="btn" href="${link({ page: list.page - 1 })}">Previous</a>` : ''}
          <span>Page ${list.page} of ${pages}</span>
          ${list.page < pages ? `<a class="btn" href="${link({ page: list.page + 1 })}">Next</a>` : ''}</nav>` : ''}
      </section>
    </div>`;
  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = new FormData(e.target);
    go('/' + qs({ ...f, q: d.get('q').trim(), sort: d.get('sort') === 'new' ? '' : d.get('sort'), page: '' }));
  });
}
function item(s) {
  return `<li class="item">
    <h3><a href="/s/${s.id}">${esc(s.title)}</a><span class="label">v${esc(s.version)}</span></h3>
    <p>${esc(s.description)}</p>
    ${s.tags ? `<div class="tags">${s.tags.split(',').map((t) => `<a class="label" href="/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
    <div class="meta"><span>${esc(s.author)}</span><span>${esc(catName(s.category))}</span><span>.${esc(s.file_type)} · ${fmtSize(s.file_size)}</span><span>${num(s.downloads)} downloads</span><span>${fmtDate(s.created_at)}</span></div>
  </li>`;
}

/* ---------- script detail ---------- */
async function detail(id) {
  app.innerHTML = loading();
  let s;
  try { s = await api('/scripts/' + id); }
  catch (e) { setTitle('Not found'); app.innerHTML = `<div class="empty"><h2>Script not found</h2><p>It may not exist, or it may still be waiting for review. <a href="/">Browse scripts</a></p></div>`; return; }
  setTitle(s.title);
  const pv = await api(`/scripts/${id}/preview`).catch(() => null);
  const [cls, lbl] = statusLabel(s.status), shareUrl = `${location.origin}/s/${s.id}`;
  let body;
  if (pv?.kind === 'zip') body = `<ul class="files">${pv.entries.map((n) => `<li>${esc(n)}</li>`).join('') || '<li>Empty archive</li>'}</ul>`;
  else if (pv) {
    const n = pv.text.replace(/\n$/, '').split('\n').length;
    body = `<div class="code"><pre class="gutter" aria-hidden="true">${Array.from({ length: n }, (_, i) => i + 1).join('\n')}</pre><pre class="src" tabindex="0"></pre></div>
            ${pv.truncated ? '<div class="box-body muted small">Preview truncated. Download the file to see everything.</div>' : ''}`;
  } else body = '<div class="box-body muted">Preview unavailable.</div>';

  app.innerHTML = `
    <div class="crumbs"><a href="/">Scripts</a> / ${esc(catName(s.category))}</div>
    <div class="title-row"><h1>${esc(s.title)}</h1><span class="label">v${esc(s.version)}</span>${s.status !== 'approved' ? `<span class="label ${cls}">${lbl}</span>` : ''}</div>
    <p class="muted">by ${esc(s.author)} · published ${fmtDate(s.created_at)}</p>
    ${s.status !== 'approved' ? `<div class="notice warn mt">${esc(lbl)}: only visible to admins.${s.reject_reason ? ' Reason: ' + esc(s.reject_reason) : ''}</div>` : ''}
    <div class="detail">
      <div class="box">
        <div class="box-head"><span>${esc(s.filename)}</span><span class="muted small">${fmtSize(s.file_size)}</span><span class="grow"></span>
          ${pv?.kind === 'text' ? '<button class="btn btn-sm" id="copycode" type="button">Copy</button>' : ''}
          <button class="btn btn-sm btn-primary" id="dl" type="button">Download</button></div>
        ${body}
      </div>
      <aside class="about-col">
        <div class="box about"><div class="box-head">About</div><div class="box-body"><dl>
          <dt>Description</dt><dd class="desc">${esc(s.description)}</dd>
          <dt>Category</dt><dd><a href="/?category=${esc(s.category)}">${esc(catName(s.category))}</a></dd>
          ${s.tags ? `<dt>Tags</dt><dd class="tags">${s.tags.split(',').map((t) => `<a class="label" href="/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</dd>` : ''}
          <dt>Version</dt><dd>${esc(s.version)}</dd>
          <dt>Author</dt><dd>${esc(s.author)}</dd>
          <dt>Published</dt><dd>${fmtDate(s.created_at)}</dd>
          <dt>Downloads</dt><dd>${num(s.downloads)}</dd>
          <dt>SHA-256</dt><dd class="small" title="${esc(s.sha256)}"><code>${esc(s.sha256.slice(0, 16))}…</code></dd>
        </dl></div></div>
        <div class="box about mt"><div class="box-head">Share</div><div class="box-body">
          <div class="share"><input type="text" readonly value="${esc(shareUrl)}" aria-label="Share link"><button class="btn" id="copylink" type="button">Copy</button></div>
          <p class="hint">Links to this page. Download links are signed and expire after 10 minutes.</p>
        </div></div>
        ${s.status === 'approved' ? '<p class="mt"><button class="btn btn-sm btn-danger" id="report" type="button">Report this script</button></p>' : ''}
      </aside>
    </div>
    <dialog id="repdlg"><form method="dialog" id="repform"><h2>Report this script</h2>
      <p class="muted small">Tell us what is wrong. An admin will review it.</p><br>
      <div class="field"><label for="reason">Reason</label><select id="reason" name="reason">
        <option value="malicious">Malicious or harmful code</option><option value="spam">Spam or misleading</option>
        <option value="copyright">Copyright violation</option><option value="inappropriate">Inappropriate content</option><option value="other">Other</option></select></div>
      <div class="field"><label for="details">Details (optional)</label><textarea id="details" name="details" maxlength="500"></textarea></div>
      <div class="actions"><button class="btn" value="cancel" type="button" id="repcancel">Cancel</button><button class="btn btn-primary" type="submit">Send report</button></div>
    </form></dialog>`;
  if (pv?.kind === 'text') $('.src').textContent = pv.text;
  $('#copylink').onclick = () => copy(shareUrl, 'Link copied');
  if ($('#copycode')) $('#copycode').onclick = () => copy(pv.text, 'Code copied');
  $('#dl').onclick = async (e) => {
    e.target.disabled = true;
    try { const { url } = await api(`/scripts/${id}/download-link`, { method: 'POST' }); location.href = API_ORIGIN + url; }
    catch (err) { toast(err.message, true); }
    setTimeout(() => (e.target.disabled = false), 1500);
  };
  const dlg = $('#repdlg');
  if ($('#report')) $('#report').onclick = () => dlg.showModal();
  $('#repcancel').onclick = () => dlg.close();
  $('#repform').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/scripts/${id}/report`, { method: 'POST', body: { reason: $('#reason').value, details: $('#details').value } }); dlg.close(); toast('Report sent. Thank you.'); }
    catch (err) { toast(err.message, true); }
  };
}

/* ---------- publish ---------- */
async function publish() {
  setTitle('Publish a script');
  const { categories, limits } = boot, maxMb = limits.maxBytes / 1048576;
  app.innerHTML = `<div class="narrow">
    <div class="page-head"><h1>Publish a script</h1></div>
    <p class="muted">No account needed. Submissions are reviewed by an admin before they appear in the library.</p><br>
    <div id="msg"></div>
    <form id="pubform" novalidate>
      <div class="field"><label for="title">Title</label><input type="text" id="title" name="title" required minlength="3" maxlength="80"></div>
      <div class="field"><label for="description">Description</label><textarea id="description" name="description" required minlength="10" maxlength="2000"></textarea>
        <div class="hint">What it does, how to use it, requirements. 10 to 2000 characters.</div></div>
      <div class="row">
        <div class="field"><label for="category">Category</label><select id="category" name="category" required>
          <option value="">Choose…</option>${categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="version">Version</label><input type="text" id="version" name="version" value="1.0.0" maxlength="20"></div>
      </div>
      <div class="row">
        <div class="field"><label for="author">Author name</label><input type="text" id="author" name="author" maxlength="32" placeholder="Anonymous" autocomplete="nickname"></div>
        <div class="field"><label for="tags">Tags</label><input type="text" id="tags" name="tags" maxlength="200" placeholder="lua, utility"><div class="hint">Up to 6, separated by commas.</div></div>
      </div>
      <div class="field"><label for="file">File</label><input type="file" id="file" name="file" required accept="${limits.extensions.map((e) => '.' + e).join(',')}">
        <div class="hint">Max ${maxMb} MB. Allowed: ${limits.extensions.join(', ')}. ZIP files are inspected and cannot contain executables.</div></div>
      <div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
      <input type="hidden" name="ts" value="${Date.now()}">
      ${CFG.TURNSTILE_SITE_KEY ? `<div class="field cf-turnstile" data-sitekey="${esc(CFG.TURNSTILE_SITE_KEY)}"></div>` : ''}
      <p class="hint">By publishing you confirm you have the right to share this file and that it contains no malware.</p><br>
      <button class="btn btn-primary" type="submit" id="submit">Publish script</button>
    </form></div>`;
  if (CFG.TURNSTILE_SITE_KEY) { const s = document.createElement('script'); s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'; s.async = true; document.head.append(s); }
  $('#pubform').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target, msg = $('#msg'), file = form.file.files[0];
    const fail = (m) => { msg.innerHTML = errorBox(m); msg.scrollIntoView({ block: 'center' }); };
    if (form.title.value.trim().length < 3) return fail('Title must be at least 3 characters.');
    if (form.description.value.trim().length < 10) return fail('Description must be at least 10 characters.');
    if (!form.category.value) return fail('Choose a category.');
    if (!file) return fail('Choose a file to upload.');
    if (!limits.extensions.includes(file.name.split('.').pop().toLowerCase())) return fail('That file type is not allowed.');
    if (file.size > limits.maxBytes) return fail(`File is too large. Maximum is ${maxMb} MB.`);
    const btn = $('#submit'); btn.disabled = true; btn.textContent = 'Publishing…';
    try {
      const r = await api('/scripts', { method: 'POST', form: new FormData(form) });
      const url = `${location.origin}/s/${r.id}`;
      app.innerHTML = `<div class="narrow"><div class="notice ok"><h2>${r.status === 'approved' ? 'Script published' : 'Submitted for review'}</h2><br>
        <p>${r.status === 'approved' ? 'Your script is live.' : 'An admin will review your script. Once approved it will be available at the link below.'}</p><br>
        <div class="share"><input type="text" readonly value="${esc(url)}" aria-label="Share link"><button class="btn" id="cp" type="button">Copy</button></div><br>
        <a class="btn" href="/publish">Publish another</a> <a class="btn" href="/">Browse scripts</a></div></div>`;
      $('#cp').onclick = () => copy(url, 'Link copied');
      boot = null;
    } catch (err) { fail(err.message); btn.disabled = false; btn.textContent = 'Publish script'; }
  };
}

/* ---------- admin ---------- */
function adminLogin(note) {
  setTitle('Admin');
  app.innerHTML = `<div class="narrow"><div class="box" id="loginbox"><div class="box-head">Admin sign in</div><form class="box-body" id="login">
    ${note ? errorBox(note) : ''}<div id="lmsg"></div>
    <div class="field"><label for="pw">Password</label><input type="password" id="pw" autocomplete="current-password" required></div>
    <button class="btn btn-primary" type="submit">Sign in</button></form></div></div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try { const r = await api('/admin/login', { method: 'POST', body: { password: $('#pw').value } }); sessionStorage.setItem(TOKEN_KEY, r.token); admin(); }
    catch (err) { $('#lmsg').innerHTML = errorBox(err.message); }
  };
}
const TABS = [['overview', 'Overview'], ['pending', 'Submissions'], ['scripts', 'Scripts'], ['reports', 'Reports'], ['categories', 'Categories'], ['settings', 'Settings']];
async function admin() {
  if (!token()) return adminLogin();
  setTitle('Admin');
  const tab = new URLSearchParams(location.search).get('tab') || 'overview';
  app.innerHTML = `<div class="page-head"><h1>Admin</h1><span class="grow"></span><button class="btn" id="logout" type="button">Sign out</button></div>
    <nav class="tabs" aria-label="Admin sections">${TABS.map(([k, l]) => `<a href="/admin?tab=${k}"${k === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav><div id="panel">${loading()}</div>`;
  $('#logout').onclick = () => { sessionStorage.removeItem(TOKEN_KEY); go('/'); };
  try { await ({ overview, pending: (el) => scriptsPanel(el, 'pending'), scripts: (el) => scriptsPanel(el, ''), reports, categories, settings }[tab] || overview)($('#panel')); }
  catch (e) { if (e.status === 401) return adminLogin('Your session expired. Sign in again.'); $('#panel').innerHTML = errorBox(e.message); }
}
async function act(fn, ok) { try { await fn(); if (ok) toast(ok); return true; } catch (e) { toast(e.message, true); return false; } }

async function overview(el) {
  const s = await api('/admin/stats');
  const days = [...Array(14)].map((_, i) => new Date(Date.now() - (13 - i) * 864e5).toISOString().slice(0, 10));
  const m = Object.fromEntries(s.daily.map((d) => [d.day, d]));
  const max = Math.max(1, ...days.map((d) => Math.max(m[d]?.uploads || 0, m[d]?.downloads || 0)));
  const bars = days.map((d, i) => {
    const u = m[d]?.uploads || 0, dl = m[d]?.downloads || 0, x = 10 + i * 46;
    return `<rect class="u" x="${x}" y="${110 - (u / max) * 100}" width="16" height="${(u / max) * 100}"><title>${d}: ${u} uploads</title></rect>
            <rect class="d" x="${x + 18}" y="${110 - (dl / max) * 100}" width="16" height="${(dl / max) * 100}"><title>${d}: ${dl} downloads</title></rect>
            <text x="${x + 17}" y="124" text-anchor="middle">${d.slice(8)}</text>`;
  }).join('');
  el.innerHTML = `<div class="stats">
      ${[['Pending', s.pending], ['Published', s.approved], ['Rejected', s.rejected], ['Downloads', s.downloads], ['Open reports', s.openReports], ['Storage', fmtSize(s.storageBytes)]]
        .map(([l, v]) => `<div class="stat"><b>${typeof v === 'number' ? num(v) : v}</b><span>${l}</span></div>`).join('')}</div>
    <div class="box"><div class="box-head">Last 14 days <span class="grow"></span><span class="legend"><span><i class="u"></i>Uploads</span><span><i class="d"></i>Downloads</span></span></div>
      <div class="box-body"><svg class="chart" viewBox="0 0 660 130" role="img" aria-label="Uploads and downloads for the last 14 days">${bars}</svg></div></div><br>
    <div class="box"><div class="box-head">Top downloads</div><div class="table-wrap"><table><tbody>
      ${s.top.map((t) => `<tr><td><a href="/s/${t.id}">${esc(t.title)}</a></td><td>${num(t.downloads)} downloads</td></tr>`).join('') || '<tr><td class="muted">No downloads yet</td></tr>'}</tbody></table></div></div>`;
}

async function scriptsPanel(el, status) {
  const st = { status, q: '', page: 1 };
  const draw = async () => {
    const [d] = await Promise.all([api('/admin/scripts' + qs({ ...st, page: st.page > 1 ? st.page : '' }))]);
    const pages = Math.max(1, Math.ceil(d.total / d.per));
    el.innerHTML = `<form class="toolbar" id="af"><input type="search" name="q" value="${esc(st.q)}" placeholder="Search scripts" aria-label="Search">
        ${status === 'pending' ? '' : `<select name="status" aria-label="Status">${[['', 'All statuses'], ['pending', 'Pending'], ['approved', 'Published'], ['rejected', 'Rejected']].map(([v, l]) => `<option value="${v}"${st.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`}
        <button class="btn" type="submit">Filter</button></form>
      <div class="box"><div class="box-head">${num(d.total)} ${status === 'pending' ? 'awaiting review' : 'scripts'}</div>
      ${d.items.length ? `<div class="table-wrap"><table><thead><tr><th>Script</th><th>Category</th><th>Status</th><th>File</th><th>Downloads</th><th>Actions</th></tr></thead><tbody>
        ${d.items.map((s) => { const [c, l] = statusLabel(s.status); return `<tr data-id="${s.id}">
          <td><a href="/s/${s.id}">${esc(s.title)}</a><div class="muted small">${esc(s.author)} · ${fmtDate(s.created_at)}</div></td>
          <td><select data-act="cat" aria-label="Category">${boot.categories.map((k) => `<option value="${esc(k.slug)}"${k.slug === s.category ? ' selected' : ''}>${esc(k.name)}</option>`).join('')}</select></td>
          <td><span class="label ${c}">${l}</span></td><td class="small">.${esc(s.file_type)} · ${fmtSize(s.file_size)}</td><td>${num(s.downloads)}</td>
          <td><div class="actions">${s.status !== 'approved' ? '<button class="btn btn-sm btn-primary" data-act="approve">Approve</button>' : ''}
            ${s.status !== 'rejected' ? '<button class="btn btn-sm" data-act="reject">Reject</button>' : ''}
            <button class="btn btn-sm" data-act="rename">Rename</button><button class="btn btn-sm btn-danger" data-act="remove">Remove</button></div></td></tr>`; }).join('')}
        </tbody></table></div>` : `<div class="empty"><h2>${status === 'pending' ? 'Nothing to review' : 'No scripts'}</h2></div>`}</div>
      ${pages > 1 ? `<nav class="pager"><button class="btn" data-act="prev"${st.page < 2 ? ' disabled' : ''}>Previous</button><span>Page ${st.page} of ${pages}</span><button class="btn" data-act="next"${st.page >= pages ? ' disabled' : ''}>Next</button></nav>` : ''}`;
  };
  el.onsubmit = (e) => { e.preventDefault(); const d = new FormData(e.target); st.q = d.get('q').trim(); if (d.has('status')) st.status = d.get('status'); st.page = 1; draw(); };
  el.onchange = async (e) => {
    if (e.target.dataset.act !== 'cat') return;
    await act(() => api('/admin/scripts/' + e.target.closest('tr').dataset.id, { method: 'PATCH', body: { category: e.target.value } }), 'Category updated');
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const a = b.dataset.act, id = b.closest('tr')?.dataset.id;
    if (a === 'prev') { st.page--; return draw(); } if (a === 'next') { st.page++; return draw(); }
    let ok = false;
    if (a === 'approve') ok = await act(() => api('/admin/scripts/' + id, { method: 'PATCH', body: { status: 'approved' } }), 'Approved');
    if (a === 'reject') { const r = prompt('Reason for rejection (optional):'); if (r === null) return; ok = await act(() => api('/admin/scripts/' + id, { method: 'PATCH', body: { status: 'rejected', reject_reason: r } }), 'Rejected'); }
    if (a === 'rename') { const t = prompt('New title:', b.closest('tr').querySelector('a').textContent); if (!t) return; ok = await act(() => api('/admin/scripts/' + id, { method: 'PATCH', body: { title: t } }), 'Renamed'); }
    if (a === 'remove') { if (!confirm('Permanently delete this script and its file?')) return; ok = await act(() => api('/admin/scripts/' + id, { method: 'DELETE' }), 'Removed'); }
    if (ok) draw();
  };
  await draw();
}

async function reports(el) {
  let status = 'open';
  const draw = async () => {
    const { items } = await api('/admin/reports?status=' + status);
    el.innerHTML = `<div class="toolbar"><select id="rs" aria-label="Report status">${['open', 'resolved', 'dismissed'].map((s) => `<option value="${s}"${s === status ? ' selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></div>
      <div class="box"><div class="box-head">${items.length} ${status} ${items.length === 1 ? 'report' : 'reports'}</div>
      ${items.length ? `<div class="table-wrap"><table><thead><tr><th>Script</th><th>Reason</th><th>Details</th><th>Date</th><th>Actions</th></tr></thead><tbody>
        ${items.map((r) => `<tr data-id="${r.id}" data-script="${esc(r.script_id)}"><td>${r.title ? `<a href="/s/${esc(r.script_id)}">${esc(r.title)}</a>` : '<span class="muted">Deleted</span>'}</td>
          <td><span class="label warn">${esc(r.reason)}</span></td><td>${esc(r.details || '')}</td><td class="small">${fmtDate(r.created_at)}</td>
          <td><div class="actions">${status === 'open' ? '<button class="btn btn-sm" data-act="resolved">Resolve</button><button class="btn btn-sm" data-act="dismissed">Dismiss</button>' : '<button class="btn btn-sm" data-act="open">Reopen</button>'}
            ${r.title ? '<button class="btn btn-sm btn-danger" data-act="remove">Remove script</button>' : ''}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h2>No reports</h2></div>'}</div>`;
    $('#rs').onchange = (e) => { status = e.target.value; draw(); };
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const tr = b.closest('tr'), a = b.dataset.act; let ok;
    if (a === 'remove') { if (!confirm('Permanently delete the reported script and its file?')) return; ok = await act(() => api('/admin/scripts/' + tr.dataset.script, { method: 'DELETE' }), 'Script removed'); }
    else ok = await act(() => api('/admin/reports/' + tr.dataset.id, { method: 'PATCH', body: { status: a } }), 'Report updated');
    if (ok) draw();
  };
  await draw();
}

async function categories(el) {
  const draw = async () => {
    const { categories: cs } = await api('/categories'); boot = { ...boot, categories: cs };
    el.innerHTML = `<form class="toolbar" id="addcat"><input type="text" name="name" maxlength="32" placeholder="New category name" aria-label="New category name" required><button class="btn btn-primary" type="submit">Add category</button></form>
      <div class="box"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Slug</th><th>Scripts</th><th>Actions</th></tr></thead><tbody>
      ${cs.map((c) => `<tr data-slug="${esc(c.slug)}"><td>${esc(c.name)}</td><td><code>${esc(c.slug)}</code></td><td>${c.count}</td>
        <td><div class="actions"><button class="btn btn-sm" data-act="rename">Rename</button>${c.slug === 'other' ? '' : '<button class="btn btn-sm btn-danger" data-act="delete">Delete</button>'}</div></td></tr>`).join('')}</tbody></table></div></div>
      <p class="hint">Deleting a category moves its scripts to "Other". Counts include published scripts only.</p>`;
    $('#addcat').onsubmit = async (e) => { e.preventDefault(); if (await act(() => api('/admin/categories', { method: 'POST', body: { name: e.target.name.value } }), 'Category added')) draw(); };
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const tr = b.closest('tr'), slug = tr.dataset.slug; let ok;
    if (b.dataset.act === 'rename') { const n = prompt('New name:', tr.children[0].textContent); if (!n) return; ok = await act(() => api('/admin/categories/' + slug, { method: 'PATCH', body: { name: n } }), 'Renamed'); }
    else { if (!confirm('Delete this category? Its scripts move to "Other".')) return; ok = await act(() => api('/admin/categories/' + slug, { method: 'DELETE' }), 'Category deleted'); }
    if (ok) draw();
  };
  await draw();
}

async function settings(el) {
  const s = await api('/admin/settings');
  el.innerHTML = `<div class="box narrow"><div class="box-head">Moderation</div><div class="box-body"><div class="switch">
    <input type="checkbox" id="auto"${s.auto_approve ? ' checked' : ''}><div><label for="auto">Publish new uploads immediately</label>
    <div class="hint">Off by default. When off, every upload waits in Submissions until you approve it.</div></div></div></div></div>`;
  $('#auto').onchange = (e) => act(() => api('/admin/settings', { method: 'PUT', body: { auto_approve: e.target.checked } }), 'Setting saved');
}

render();
})();
