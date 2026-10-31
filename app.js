/* LOCAL MARKET: plain JavaScript, no build step. Data lives in this browser's localStorage. */

// ===== SETTINGS YOU CAN CHANGE =====
// display only, shown on the admin page. Admin rights come from the user row's isAdmin flag.
const ADMIN_EMAIL = 'your-admin-email@example.com';
const BANK = { name: 'SADCO Ventures Ltd', bank: 'Zenith Bank', acct: '0000000000' }; // PLACEHOLDER: replace with real account number
const VERIFY_NOTE = 'Pay the verification fee directly to the LOCAL MARKET admin (the amount is confirmed by LOCAL MARKET support).';
const CATS = ['Phones & Tablets', 'Fashion', 'Home & Kitchen', 'Electronics', 'Computers', 'Beauty & Health', 'Baby Products', 'Building & Tools', 'Food & Drinks', 'Vehicles', 'Others'];
const CAT_ICON = { 'Phones & Tablets': '📱', 'Fashion': '👗', 'Home & Kitchen': '🍳', 'Electronics': '📺', 'Computers': '💻', 'Beauty & Health': '💄', 'Baby Products': '🍼', 'Building & Tools': '🔧', 'Food & Drinks': '🥫', 'Vehicles': '🚗', 'Others': '🛍️' };
const REACTS = [['heart', '❤️', 'Like'], ['fire', '🔥', 'Hot'], ['love', '😍', 'Love'], ['thumb', '👍', 'Nice'], ['laugh', '😂', 'Funny']];
const MAX_PHOTOS = 8;
const THEME_KEY = 'localmarket_theme';
function loadTheme() { try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; } }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themebtn'); if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const t = loadTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  applyTheme(t);
}

// ===== STORAGE =====
const KEY = 'sadco_market_v1';
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function nowMs() { return Date.now(); }
function seed() {
  // no admin row is created here: admin rights come only from a user row with isAdmin:true (see README)
  const t = nowMs();
  const samples = [
    { id: uid(), sellerId: 'sample', title: 'Samsung Galaxy A15 128GB (sample listing)', desc: 'Sample listing to show how the page looks. Delete it from the admin panel when you are ready.', category: 'Phones & Tablets', price: 145000, discount: 129000, photo: '', images: [], created: t, sample: true },
    { id: uid(), sellerId: 'sample', title: 'Ankara Print Two-piece Set (sample listing)', desc: 'Sample listing. Free size, cotton blend.', category: 'Fashion', price: 18500, discount: 0, photo: '', images: [], created: t, sample: true },
    { id: uid(), sellerId: 'sample', title: 'Non-stick Pressure Pot 10L (sample listing)', desc: 'Sample listing. Cooks faster, safe non-stick coating.', category: 'Home & Kitchen', price: 32000, discount: 27500, photo: '', images: [], created: t, sample: true }
  ];
  return { users: [], listings: samples, comments: [], messages: [], verifyRequests: [], reactions: [], follows: [], session: null };
}
function fixup(d) {
  d.reactions = d.reactions || [];
  d.messages = d.messages || [];
  delete d.cart; delete d.orders; // checkout removed: buyers and sellers agree in chat
  d.follows = d.follows || [];
  d.follows.forEach(f => { if (!f.status) f.status = 'accepted'; });
  d.users.forEach(u => { if (u.info === undefined) u.info = ''; if (u.bio === undefined) u.bio = ''; });
  d.listings.forEach(l => { if (!Array.isArray(l.images)) l.images = []; });
  d.verifyRequests.forEach(r => { if (r.doc === undefined) r.doc = ''; });
  // per-message read tracking: readBy lists the user ids who have read the message
  d.messages.forEach(m => { if (!Array.isArray(m.readBy)) m.readBy = [m.from]; });
  // last heartbeat time per user (online = active in the last 2 minutes)
  d.users.forEach(u => { if (u.lastActive === undefined) u.lastActive = 0; });
  return d;
}
const SESSION_KEY = 'localmarket_session'; // the login stays in this browser only
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!d || !Array.isArray(d.users)) d = seed();
  d = fixup(d);
  try { d.session = localStorage.getItem(SESSION_KEY) || null; } catch (e) { d.session = null; }
  return d;
}
let db = load();
let sbLastSession = undefined;
function save() {
  // the local cache keeps everything except the session, which lives only in this browser
  try { localStorage.setItem(KEY, JSON.stringify(Object.assign({}, db, { session: null }))); } catch (e) { toast('Browser storage is full. Use fewer or smaller photos, or delete old listings.'); }
  try { if (db.session) localStorage.setItem(SESSION_KEY, db.session); else localStorage.removeItem(SESSION_KEY); } catch (e) {}
  if (db.session !== sbLastSession) { sbLastSession = db.session; pruneMessages(); if (sbReady) sbPull(); }
  sbDiff(); // mark changed entities dirty and schedule a push of only those
}

// ===== ONLINE SYNC (Supabase, free) =====
// Table localmarket_store holds ONE ROW PER ENTITY:
//   id   = 'user:<id>' | 'listing:<id>' | 'comment:<id>' | 'msg:<id>' | 'verify:<id>' | 'react:<id>' | 'follow:<follower>_<following>'
//   data = the entity JSON plus _ts (when it last changed); updated_at = when the row was pushed.
// Writes: changed entities are marked dirty; a debounced push sends ONLY those rows, one request per entity.
// Reads: every 5 seconds all rows are pulled and merged entity by entity, the newer _ts wins.
// Deleted entities are pushed as tombstones ({_deleted:true}) so a later pull does not bring them back.
// Notifications are not stored: they are derived from reactions, comments and follow requests.
// Direct messages: a device only keeps the messages of its own logged-in user. The admin keeps none.
// Limit: the anon key can read the whole table, so DM privacy is enforced by this app only.
// Real privacy needs Supabase Auth plus row-level security.
const SB_URL = 'https://txvfghqvqcnzfnbjmcji.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4dmZnaHF2cWNuemZuYmptY2ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5NDY0NjIsImV4cCI6MjEwODUyMjQ2Mn0.a7jRA7VxxM9LRgWD_Lq2_dcUAHETcTOaThVLkT6AVjs';
const SB_TABLE = 'localmarket_store';
const SB_LEGACY_ROW = 'state'; // the old whole-app row, migrated once and then removed
const SB_KINDS = [['users', 'user'], ['listings', 'listing'], ['comments', 'comment'], ['messages', 'msg'], ['verifyRequests', 'verify'], ['reactions', 'react'], ['follows', 'follow']];
const SB_FIELD = {};
SB_KINDS.forEach(([f, p]) => { SB_FIELD[p] = f; });
const sbSnap = {};          // key -> JSON of the entity as last synced (without _ts)
const sbDirty = new Map();  // key -> entity still to push (null = push a delete tombstone)
const sbRetry = {};
let sbPushTimer = null, sbPulling = false, sbReady = false;
let sbLegacyPending = false, sbLegacyExtra = [];

const SB_TOKEN_KEY = 'localmarket_token', SB_REFRESH_KEY = 'localmarket_refresh';
function sbToken() { try { return localStorage.getItem(SB_TOKEN_KEY) || ''; } catch (e) { return ''; } }
// the logged-in user's access_token; the anon key is used only when nobody is logged in (public listing/profile reads)
function sbAuthHeader() { return 'Bearer ' + (sbToken() || SB_KEY); }
function sbSaveSession(tok, rt) { try { localStorage.setItem(SB_TOKEN_KEY, tok); if (rt) localStorage.setItem(SB_REFRESH_KEY, rt); } catch (e) {} }
function sbClearSession() { try { localStorage.removeItem(SB_TOKEN_KEY); localStorage.removeItem(SB_REFRESH_KEY); } catch (e) {} }
async function sbAuth(path, body) {
  try {
    const r = await fetch(SB_URL + '/auth/v1/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, data: j || {} };
  } catch (e) { return { ok: false, data: { msg: 'Network error. Check your connection.' } }; }
}
// access tokens expire after about an hour; swap in a new one with the refresh token
async function sbRefresh() {
  let rt = ''; try { rt = localStorage.getItem(SB_REFRESH_KEY) || ''; } catch (e) {}
  if (!rt) return false;
  const r = await sbAuth('token?grant_type=refresh_token', { refresh_token: rt });
  if (!r.ok || !r.data.access_token) return false;
  sbSaveSession(r.data.access_token, r.data.refresh_token); return true;
}
function sbHeaders() {
  return { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': sbAuthHeader(), 'Prefer': 'return=minimal,resolution=merge-duplicates' };
}
function sbReadHeaders() { return { 'apikey': SB_KEY, 'Authorization': sbAuthHeader() }; }
function sbKey(prefix, o) { return prefix === 'follow' ? 'follow:' + o.follower + '_' + o.following : prefix + ':' + o.id; }
function sbEach(fn) { SB_KINDS.forEach(([f, p]) => (db[f] || []).forEach(o => fn(sbKey(p, o), o))); }
function sbBody(o) { return JSON.stringify(o, (k, v) => (k === '_ts' ? undefined : v)); }
// direct messages are only kept for the user in the thread; the admin never keeps any
function visibleMsg(m) { const u = me(); return !!u && !u.isAdmin && (m.from === u.id || m.to === u.id); }
function pruneMessages() {
  db.messages = db.messages.filter(m => {
    if (visibleMsg(m)) return true;
    const k = 'msg:' + m.id; delete sbSnap[k]; sbDirty.delete(k); return false;
  });
}
// compare every entity with its last synced copy: changed ones get a fresh _ts and go dirty, removed ones become tombstones
function sbDiff() {
  const now = nowMs(), seen = new Set();
  sbEach((k, o) => {
    seen.add(k);
    const b = sbBody(o);
    if (sbSnap[k] !== b) { o._ts = now; sbSnap[k] = b; sbDirty.set(k, o); }
  });
  Object.keys(sbSnap).forEach(k => { if (!seen.has(k)) { delete sbSnap[k]; sbDirty.set(k, null); } });
  if (sbDirty.size && sbReady) sbSchedule(800);
}
function sbSchedule(ms) { if (sbPushTimer) clearTimeout(sbPushTimer); sbPushTimer = setTimeout(sbPush, ms); }
// one request per entity; each one has its own catch, so one failing row (e.g. an oversized photo) does not stop the rest
function sbPutRow(key, data, stamp) {
  try {
    return fetch(SB_URL + '/rest/v1/' + SB_TABLE + '?on_conflict=id', { method: 'POST', headers: sbHeaders(), body: JSON.stringify({ id: key, data: data, updated_at: stamp }) })
      .then(r => r.ok).catch(() => false);
  } catch (e) { return Promise.resolve(false); }
}
function sbPush() {
  if (sbPushTimer) { clearTimeout(sbPushTimer); sbPushTimer = null; }
  if (!sbReady || (!sbDirty.size && !sbLegacyPending)) return;
  const stamp = new Date().toISOString();
  const batch = [...sbDirty.entries()];
  sbDirty.clear();
  const jobs = batch.map(([key, o]) => {
    const data = o || { _deleted: true, _ts: nowMs() };
    return sbPutRow(key, data, stamp).then(ok => {
      if (ok) { delete sbRetry[key]; return true; }
      const n = (sbRetry[key] || 0) + 1; sbRetry[key] = n;
      if (n <= 5) { if (!sbDirty.has(key)) sbDirty.set(key, o); sbSchedule(10000); }
      return false;
    });
  });
  if (sbLegacyPending) {
    // migration rows (other people's DMs are kept in the cloud, not on this device) go up with this push
    const extra = sbLegacyExtra.map(([k, o]) => sbPutRow(k, o, stamp));
    Promise.all(jobs.concat(extra)).then(oks => {
      if (oks.every(Boolean)) { sbLegacyPending = false; sbLegacyExtra = []; sbDeleteLegacy(); }
    });
  }
}
// The old 'state' row is removed once all migrated rows are saved. If the anon key is not allowed to delete,
// the request fails quietly; the row is then ignored, because entity rows now exist and it is never read again.
function sbDeleteLegacy() {
  try { fetch(SB_URL + '/rest/v1/' + SB_TABLE + '?id=eq.' + SB_LEGACY_ROW, { method: 'DELETE', headers: sbReadHeaders() }).catch(() => {}); } catch (e) {}
}
// PostgREST returns at most 1000 rows per request, so read in pages
async function sbFetchAll() {
  const out = [];
  for (let off = 0; off < 200000; off += 1000) {
    const url = SB_URL + '/rest/v1/' + SB_TABLE + '?select=id,data,updated_at&order=id&limit=1000&offset=' + off;
    let r = await fetch(url, { headers: sbReadHeaders() });
    if (r.status === 401 && await sbRefresh()) r = await fetch(url, { headers: sbReadHeaders() });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows)) return null;
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function sbPull() {
  if (sbPulling) return;
  sbPulling = true;
  try {
    const rows = await sbFetchAll();
    if (!rows) return;
    const remote = {}, stamp = {};
    let legacy = null;
    rows.forEach(row => {
      if (!row || !row.data || typeof row.data !== 'object') return;
      if (row.id === SB_LEGACY_ROW) { legacy = row; return; }
      if (!SB_FIELD[String(row.id).split(':')[0]]) return;
      remote[row.id] = row.data;
      stamp[row.id] = Number(row.data._ts) || Date.parse(row.updated_at) || 0;
    });
    if (sbReady) sbMerge(remote, stamp); else sbFirstLoad(remote, stamp, legacy);
  } catch (e) { /* offline: keep the local copy, try again in 5 seconds */ }
  finally { sbPulling = false; }
}
function sbFirstLoad(remote, stamp, legacy) {
  if (Object.keys(remote).length) {
    sbSetAll(remote, stamp); // the cloud already has entity rows: cloud wins on first load
  } else if (legacy && legacy.data && Array.isArray(legacy.data.users)) {
    // one-time migration from the old whole-app row (id 'state') into one row per entity
    SB_KINDS.forEach(([f]) => { db[f] = Array.isArray(legacy.data[f]) ? legacy.data[f] : []; });
    fixup(db);
    const ts = Date.parse(legacy.updated_at) || nowMs();
    sbLegacyExtra = db.messages.filter(m => !visibleMsg(m)).map(m => ['msg:' + m.id, Object.assign({}, m, { _ts: ts })]);
    sbLegacyPending = true;
    pruneMessages();
  }
  // empty table: this device's copy (with the seed data) is pushed up
  Object.keys(sbSnap).forEach(k => { delete sbSnap[k]; });
  sbDirty.clear();
  sbReady = true;
  init(); // makes sure the admin exists; everything not yet on the server is marked dirty and pushed
  syncRender();
}
function sbSetAll(remote, stamp) {
  SB_KINDS.forEach(([f]) => { db[f] = []; });
  // users first, so the DM check below can see who is logged in
  Object.keys(remote).filter(k => !remote[k]._deleted)
    .sort((a, b) => (a.indexOf('msg:') === 0) - (b.indexOf('msg:') === 0))
    .forEach(k => {
      const o = remote[k]; o._ts = stamp[k];
      const f = SB_FIELD[k.split(':')[0]];
      if (f === 'messages' && !visibleMsg(o)) return;
      db[f].push(o);
    });
  fixup(db);
  Object.keys(sbSnap).forEach(k => { delete sbSnap[k]; });
  sbDirty.clear();
  sbEach((k, o) => { sbSnap[k] = sbBody(o); });
}
// after the first load: merge entity by entity, newer _ts wins
function sbMerge(remote, stamp) {
  const loc = new Map();
  sbEach((k, o) => loc.set(k, o));
  let changed = false;
  Object.keys(remote).sort((a, b) => (a.indexOf('msg:') === 0) - (b.indexOf('msg:') === 0)).forEach(k => {
    const f = SB_FIELD[k.split(':')[0]], o = remote[k], rts = stamp[k];
    const lo = loc.get(k), lts = lo ? (lo._ts || 0) : -1;
    if (rts <= lts) return; // this device's copy is as new or newer
    if (f === 'messages' && !o._deleted && !visibleMsg(o)) return;
    try {
      if (o._deleted) {
        if (lo) db[f] = db[f].filter(x => x !== lo);
        delete sbSnap[k]; sbDirty.delete(k);
      } else {
        o._ts = rts;
        const i = lo ? db[f].indexOf(lo) : -1;
        if (i >= 0) db[f][i] = o; else db[f].push(o);
        sbSnap[k] = sbBody(o); sbDirty.delete(k);
      }
      changed = true;
    } catch (e) {}
  });
  const before = db.messages.length;
  pruneMessages();
  if (changed || db.messages.length !== before) { save(); syncRender(); }
  if (sbDirty.size) sbSchedule(800);
}
// re-render after a pull, but not while someone is typing in a form
let sbNeedRender = false;
function syncRender() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { sbNeedRender = true; return; }
  const y = window.scrollY; sbNeedRender = false; render(); window.scrollTo(0, y);
}
document.addEventListener('focusout', () => {
  if (!sbNeedRender) return;
  setTimeout(() => { const a = document.activeElement; if (!a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) syncRender(); }, 400);
});
// receiver pop: one card per incoming follow request, remembered in localStorage
function checkIncomingFollowPops() {
  const u = me(); if (!u) return;
  const KEY2 = 'sadco_fpop_seen';
  let seen = []; try { seen = JSON.parse(localStorage.getItem(KEY2) || '[]'); } catch (e) { seen = []; }
  const fresh = (db.follows || []).filter(f => f.following === u.id && f.status === 'pending' && !seen.includes(f.follower + '>' + f.following + ':' + (f.at || '')));
  if (!fresh.length) return;
  const f = fresh[0]; const from = byId(f.follower);
  seen = seen.concat(fresh.map(x => x.follower + '>' + x.following + ':' + (x.at || '')));
  try { localStorage.setItem(KEY2, JSON.stringify(seen.slice(-200))); } catch (e) {}
  if (!from) return;
  const m = document.getElementById('followpop') || (() => { const d = document.createElement('div'); d.id = 'followpop'; d.className = 'fpop-wrap'; document.body.appendChild(d); return d; })();
  m.innerHTML = '<div class="fpop-card" role="dialog" aria-modal="true"><div class="fpop-check">&#128100;</div><p class="fpop-msg">' + esc(from.name) + ' sent you a follow request</p><button class="btn fpop-ok" onclick="document.getElementById(\'followpop\').innerHTML=\'\';location.hash=\'#/me\'">OK</button></div>';
}
setInterval(() => { sbPull(); }, 5000);
setTimeout(checkIncomingFollowPops, 1500);
setInterval(checkIncomingFollowPops, 5000);
window.addEventListener('online', sbPull);
document.addEventListener('visibilitychange', () => { if (document.hidden && sbPushTimer) sbPush(); });
function init() {
  // no admin re-creation: the admin is a normal user row with isAdmin:true
  save();
}
init(); applyTheme(loadTheme()); sbPull();

// ===== HELPERS =====
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function naira(n) { return '₦' + Math.round(Number(n) || 0).toLocaleString('en-NG'); }
function when(t) { return new Date(t).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }); }
function me() { return db.session ? db.users.find(u => u.id === db.session) || null : null; }
function byId(id) { return db.users.find(u => u.id === id) || null; }
function listingById(id) { return db.listings.find(l => l.id === id) || null; }
function fv(f, name) { const el = f.elements[name]; return el ? el.value : ''; }
function num(v) { return Number(String(v || '').replace(/[,₦\\s]/g, '')); }
function toast(m) {
  const t = document.getElementById('toast');
  t.textContent = m; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2400);
}
function badge(u) { return (u && u.verified ? ' <span class="vbadge">✔ Verified</span>' : '') + flagHTML(u); }
function tick(u) { return (u && u.verified ? ' <span class="vbadge">✔</span>' : '') + flagHTML(u); }
function effective(l) { return l.discount && l.discount < l.price ? l.discount : l.price; }
function priceHTML(l, big) {
  if (l.discount && l.discount < l.price) {
    const pct = Math.round((1 - l.discount / l.price) * 100);
    return `<span class="old">${naira(l.price)}</span><span class="new">${naira(l.discount)}</span>` + (big ? '' : ` <span class="pct">-${pct}%</span>`);
  }
  return `<span class="new">${naira(l.price)}</span>`;
}
// all pictures for a listing: uploaded gallery photos first, then any photo link
function allImages(l) {
  if (!l) return [];
  const arr = (l.images || []).slice();
  if (l.photo) arr.push(l.photo);
  return arr;
}
function photoHTML(l, big) {
  const arr = allImages(l);
  if (arr.length) return `<img class="${big ? 'bigphoto' : 'thumb'}" src="${esc(arr[0])}" alt="${esc(l.title)}">`;
  return `<div class="${big ? 'bigphoto' : 'thumb'}">${CAT_ICON[l.category] || '🛍️'}</div>`;
}
function gallery(l) {
  const arr = allImages(l);
  if (!arr.length) return photoHTML(l, true);
  const thumbs = arr.length > 1 ? `<div class="thumbs">${arr.map((s, i) => `<img class="thumbpic" src="${esc(s)}" alt="" onclick="showPic(${i},'${l.id}')">`).join('')}</div>` : '';
  return `<img id="mainimg" class="bigphoto" src="${esc(arr[0])}" alt="${esc(l.title)}">${thumbs}`;
}
function showPic(i, lid) {
  const arr = allImages(listingById(lid));
  const el = document.getElementById('mainimg');
  if (el && arr[i]) el.src = arr[i];
}

// likes and emoji reactions: one reaction per user per listing
function likeCount(lid) { return db.reactions.filter(r => r.listingId === lid).length; }
function reactCounts(lid) {
  const c = {}; REACTS.forEach(r => c[r[0]] = 0);
  db.reactions.filter(r => r.listingId === lid).forEach(r => { if (c[r.type] !== undefined) c[r.type]++; });
  return c;
}
function myReact(lid) {
  const u = me(); if (!u) return null;
  const r = db.reactions.find(x => x.listingId === lid && x.userId === u.id);
  return r ? r.type : null;
}
function react(lid, type) {
  const u = me(); if (!u) return needLogin('item/' + lid);
  if (!listingById(lid)) return;
  const i = db.reactions.findIndex(r => r.listingId === lid && r.userId === u.id);
  if (i >= 0) {
    if (db.reactions[i].type === type) { db.reactions.splice(i, 1); toast('Reaction removed'); }
    else { db.reactions[i].type = type; toast('Reaction changed'); }
  } else {
    db.reactions.push({ id: uid(), listingId: lid, userId: u.id, ownerId: u.ownerId || '', type, at: nowMs() });
    toast('Thanks for reacting!');
  }
  save(); render();
}
function reactBar(l) {
  const cnt = reactCounts(l.id), mine = myReact(l.id), total = likeCount(l.id);
  const u = me();
  const note = !u ? '<a href="#/login?next=' + encodeURIComponent('item/' + l.id) + '">Log in</a> to react'
    : mine ? 'Tap your reaction again to remove it, or tap another to change it.' : 'Tap a reaction to show you like it.';
  return `<div class="reacts">${REACTS.map(([k, e, t]) => `<button class="rbtn ${mine === k ? 'on' : ''}" onclick="react('${l.id}','${k}')">${e} ${t} <b>${cnt[k]}</b></button>`).join('')}</div>
    <div class="muted">${total} reaction${total === 1 ? '' : 's'} · ${note}</div>`;
}

// follows: a follow is a request (status 'pending') until the other person accepts ('accepted')
function followRec(a, b) { return db.follows.find(f => f.follower === a && f.following === b); }
function isFollowing(a, b) { const r = followRec(a, b); return !!r && r.status === 'accepted'; }
function isRequested(a, b) { const r = followRec(a, b); return !!r && r.status === 'pending'; }
function followersOf(id) { return db.follows.filter(f => f.following === id && f.status === 'accepted').map(f => byId(f.follower)).filter(Boolean); }
function followingOf(id) { return db.follows.filter(f => f.follower === id && f.status === 'accepted').map(f => byId(f.following)).filter(Boolean); }
function pendingRequestsFor(id) { return db.follows.filter(f => f.following === id && f.status === 'pending').map(f => byId(f.follower)).filter(Boolean); }
// Centered check-mark confirmation card for follow actions
function followPop(msg) {
  let m = document.getElementById('followpop');
  if (!m) {
    m = document.createElement('div'); m.id = 'followpop'; m.className = 'fpop-wrap';
    document.body.appendChild(m);
  }
  m.innerHTML = '<div class="fpop-card" role="dialog" aria-modal="true"><div class="fpop-check">&#10003;</div><p class="fpop-msg">' + esc(msg) + '</p><button class="btn fpop-ok" onclick="document.getElementById(\'followpop\').innerHTML=\'\'">OK</button></div>';
}
function toggleFollow(id) {
  const u = me(); if (!u) return needLogin('user/' + id);
  if (u.id === id || !byId(id)) return;
  const i = db.follows.findIndex(f => f.follower === u.id && f.following === id);
  if (i >= 0) { db.follows.splice(i, 1); toast('Unfollowed or request cancelled'); }
  else { db.follows.push({ follower: u.id, following: id, ownerId: u.ownerId || '', targetOwner: (byId(id) || {}).ownerId || '', status: 'pending', at: nowMs() }); followPop('Follow request sent to ' + byId(id).name); }
  save(); render();
}
function acceptFollow(fromId) {
  const u = me(); if (!u) return needLogin('home');
  const r = followRec(fromId, u.id);
  if (!r || r.status !== 'pending') return;
  r.status = 'accepted'; r.acceptedAt = nowMs();
  // mutual: make sure u also follows them (accepted) so both see each other's items
  let back = followRec(u.id, fromId);
  if (!back) db.follows.push({ follower: u.id, following: fromId, ownerId: u.ownerId || '', targetOwner: (byId(fromId) || {}).ownerId || '', status: 'accepted', at: nowMs(), acceptedAt: nowMs() });
  else { back.status = 'accepted'; back.acceptedAt = nowMs(); }
  save(); followPop('You now follow ' + byId(fromId).name); render();
}
function declineFollow(fromId) {
  const u = me(); if (!u) return needLogin('home');
  db.follows = db.follows.filter(f => !(f.follower === fromId && f.following === u.id && f.status === 'pending'));
  save(); toast('Request declined'); render();
}
// ===== ONLINE DOTS & UNREAD BADGES =====
// Each open app tab stamps the logged-in user's lastActive every 60 seconds.
// A user counts as online if they were active in the last 2 minutes.
const ONLINE_MS = 2 * 60 * 1000;
function isOnline(u) { return !!u && !!u.lastActive && (nowMs() - u.lastActive) < ONLINE_MS; }
// green dot next to an avatar (wrap = true) or next to a name (inline)
function dotHTML(u, inline) {
  if (!u) return '';
  return `<i class="odot ${inline ? 'inl' : ''} ${isOnline(u) ? 'on' : ''}" data-dot="${u.id}" title="Online now"></i>`;
}
function avDot(u, size) {
  const sz = size ? ` style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px"` : '';
  const av = avatar(u || { name: '?' }).replace('class="av"', 'class="av"' + sz);
  return `<span class="avwrap">${av}${dotHTML(u)}</span>`;
}
function refreshDots() {
  document.querySelectorAll('[data-dot]').forEach(el => {
    const u = byId(el.getAttribute('data-dot'));
    el.classList.toggle('on', isOnline(u));
  });
}
// unread DMs = messages sent to me that I have not opened yet
function unreadCount(u) {
  if (!u) return 0;
  return db.messages.filter(m => m.to === u.id && !(m.readBy || []).includes(u.id)).length;
}
function markThreadRead(otherId) {
  const u = me(); if (!u) return;
  let changed = false;
  db.messages.forEach(m => {
    if (m.from === otherId && m.to === u.id && !(m.readBy || []).includes(u.id)) { m.readBy.push(u.id); changed = true; }
  });
  if (changed) save();
}
function notifCount(u) {
  if (!u) return 0;
  const seen = window.NOTIF_SEEN || 0;
  return notificationsFor(u).filter(n => n.at > seen).length;
}
function refreshBadges() {
  const n = unreadCount(me());
  ['ubadge-top', 'ubadge-bot'].forEach(id => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = n > 99 ? '99+' : String(n);
    el.hidden = n === 0;
  });
  const nb = document.getElementById('nbadge');
  if (nb) { const c = notifCount(me()); nb.textContent = c > 9 ? '9+' : String(c); nb.hidden = c === 0; }
}
// heartbeat: mark me as active, then update the dots and badges in place (no full re-render, so forms are not wiped)
function touch() {
  const u = me();
  if (u) { u.lastActive = nowMs(); save(); }
  refreshDots(); refreshBadges();
}
setInterval(touch, 60 * 1000);
// other tabs on this same browser: pick up their changes
window.addEventListener('storage', e => {
  if (e.key !== KEY || !e.newValue) return;
  try { const d = JSON.parse(e.newValue); if (d && Array.isArray(d.users)) db = fixup(d); } catch (err) { return; }
  refreshDots(); refreshBadges();
});

function fromFollowing(u) {
  // newest items first from accepted, mutual follows
  const ids = new Set(db.follows.filter(f => f.follower === u.id && f.status === 'accepted').map(f => f.following));
  return db.listings.filter(l => ids.has(l.sellerId)).sort((a, b) => b.created - a.created).slice(0, 12);
}

// feed ranking: your own items first, then people you follow, then everyone else (newest first)
function rankFor(list) {
  const u = me();
  const fol = new Set(u ? db.follows.filter(f => f.follower === u.id).map(f => f.following) : []);
  const score = l => (u && l.sellerId === u.id ? 2 : 0) + (fol.has(l.sellerId) ? 1 : 0);
  return list.slice().sort((a, b) => score(b) - score(a) || b.created - a.created);
}

function card(l) {
  const s = byId(l.sellerId);
  const n = likeCount(l.id);
  return `<a class="card" href="#/item/${l.id}">${photoHTML(l, false)}<div class="cbody">
    <div class="ctitle">${esc(l.title)}</div>
    <div class="cprice">${priceHTML(l, false)}</div>
    <div class="cseller">${dotHTML(s, true)}${s ? esc(s.name) : 'Seller'}${tick(s)} <span class="muted">· ❤️ ${n}</span></div></div></a>`;
}
function grid(list, empty) {
  if (!list.length) return `<div class="empty">${empty || 'Nothing here yet.'}</div>`;
  return `<div class="grid">${list.map(card).join('')}</div>`;
}
function personRow(p) {
  return `<a class="convo" href="#/user/${p.id}">${avatar(p).replace('class="av"', 'class="av" style="width:44px;height:44px;font-size:18px"')}<div><b>${esc(p.name)}</b>${badge(p)}<div class="muted">${followersOf(p.id).length} followers · ${esc(p.location) || 'Location not set'}</div></div></a>`;
}
function waLink(p) {
  if (!p || !p.wa) return '';
  const w = String(p.wa).trim();
  if (/^https?:/i.test(w)) return w;
  const digits = w.replace(/\D/g, '');
  if (!digits) return '';
  return 'https://wa.me/' + (digits.startsWith('0') ? '234' + digits.slice(1) : digits);
}
function needLogin(next) { location.hash = '#/login?next=' + encodeURIComponent(next); return false; }
function needVerify(next) {
  const u0 = me();
  if (!u0 || u0.emailVerified) return true;
  window.NEXT = next || 'me';
  location.hash = '#/emailverify';
  return false;
}
function logout() { db.session = null; sbClearSession(); save(); toast('Logged out'); location.hash = '#/'; }

// ===== AUTH =====
function normPhone(p) {
  let d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.startsWith('0')) return '+234' + d.slice(1);
  if (d.startsWith('234')) return '+' + d;
  return d ? '+' + d : '';
}
async function doRegister(e) {
  e.preventDefault();
  const f = e.target;
  const name = fv(f, 'name').trim(), email = fv(f, 'email').trim().toLowerCase(), pw = fv(f, 'password'), phone = fv(f, 'phone').trim();
  if (!name) { toast('Please enter your name'); return false; }
  if (!email) { toast('Please enter your email'); return false; }
  if (pw.length < 6) { toast('Password must be at least 6 characters'); return false; }
  if (db.users.some(u => (u.email || '').toLowerCase() === email)) { toast('That email already has an account. Log in instead.'); return false; }
  // the password goes to Supabase Auth only; the profile row never stores it
  const r = await sbAuth('signup', { email, password: pw });
if (!r.ok) { toast(r.data.msg || r.data.error_description || r.data.message || 'Could not create account. Try another email.'); return false; }
  const lg = await sbAuth('token?grant_type=password', { email, password: pw });
  if (!lg.ok || !lg.data.access_token) { toast('Account created. Log in with your email and password.'); location.hash = '#/login'; return false; }
  sbSaveSession(lg.data.access_token, lg.data.refresh_token);
  const authUid = lg.data.user.id;
  let u = db.users.find(x => x.ownerId === authUid);
  if (!u) {
    u = { id: uid(), ownerId: authUid, name, phone, email, location: fv(f, 'place').trim(), bio: '', info: '', photo: '', verified: false, isAdmin: false, created: nowMs() };
    db.users.push(u);
  }
  db.session = u.id; save();
  toast('Account created. Welcome ' + name + '!');
  location.hash = '#/';
  return false;
}
async function doLogin(e) {
  e.preventDefault();
  const f = e.target;
  const email = fv(f, 'email').trim().toLowerCase(), pw = fv(f, 'password');
  let r = await sbAuth('token?grant_type=password', { email, password: pw });
  if (!r.ok || !r.data.access_token) { toast('Wrong email or password. New here? Create an account.'); return false; }
  sbSaveSession(r.data.access_token, r.data.refresh_token);
  const authUid = r.data.user.id;
  if (!db.users.some(x => x.ownerId === authUid)) await sbPull();
  let u = db.users.find(x => x.ownerId === authUid) || db.users.find(x => (x.email || '').toLowerCase() === email && !x.ownerId) || null;
  if (!u) { u = { id: uid(), name: 'User', phone: '', email, location: '', bio: '', info: '', photo: '', verified: false, isAdmin: false, created: nowMs() }; db.users.push(u); }
  if (u.password !== undefined) delete u.password; // migration: strip the old plaintext password
  u.ownerId = authUid;
  if (u.suspended) { window.blockedId = u.id; db.session = null; save(); render(); return false; }
  db.session = u.id; save();
  toast('Logged in as ' + u.name);
  location.hash = '#/' + (window.NEXT || 'me');
  return false;
}

// ===== PHOTO HELPERS (phone gallery -> FileReader -> data URL) =====
// Resizes the picture with a canvas so it fits in browser storage. Result is still a data URL.
function readImage(file, maxSide) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error('Please choose a picture file (jpg, png)'));
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('Could not read that file'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('That picture could not be opened'));
      img.onload = () => {
        const sc = Math.min(1, maxSide / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
// ===== SUPABASE STORAGE for photos (bucket 'localmarket', public) =====
// Uploads go to storage; the entity stores only the public URL. If the upload fails, the old
// base64 data URL is kept so the app never breaks.
const SB_BUCKET = 'localmarket';
function photoExt(type) { return type === 'image/png' ? 'png' : 'jpg'; }
function dataUrlToBlob(d) {
  const parts = String(d).split(','), mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(parts[1] || ''), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
async function storePhoto(dataUrl, folder) {
  if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return dataUrl;
  try {
    const blob = dataUrlToBlob(dataUrl);
    const ext = photoExt(blob.type);
    const type = folder.replace(/\/$/, ''); const name = type + '/' + type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    const r = await fetch(SB_URL + '/storage/v1/object/' + SB_BUCKET + '/' + name, {
      method: 'POST', headers: { 'apikey': SB_KEY, 'Authorization': sbAuthHeader(), 'Content-Type': blob.type, 'x-upsert': 'false' }, body: blob
    });
    if (!r.ok) throw new Error('upload ' + r.status);
    return SB_URL + '/storage/v1/object/public/' + SB_BUCKET + '/' + name;
  } catch (e) {
    toast('Photo upload failed, saved on this device instead.');
    return dataUrl;
  }
}
// best-effort delete of a storage object created by storePhoto; ignores failures and data URLs
function deletePhotoObject(url) {
  const pre = SB_URL + '/storage/v1/object/public/' + SB_BUCKET + '/';
  if (!url || String(url).indexOf(pre) !== 0) return;
  try { fetch(SB_URL + '/storage/v1/object/' + SB_BUCKET + '/' + String(url).slice(pre.length), { method: 'DELETE', headers: { 'apikey': SB_KEY, 'Authorization': sbAuthHeader() } }).catch(() => {}); } catch (e) {}
}
// pending pictures for the listing form and the verification document
let pendingImgs = [], readingImgs = 0, docData = '', docReading = 0, pickTok = 0;
function resetPending() { pendingImgs = []; readingImgs = 0; docData = ''; docReading = 0; pickTok++; pendingAvatar = ''; }
async function pickPhotos(input, existing) {
  const room = Math.max(0, MAX_PHOTOS - existing - pendingImgs.length - readingImgs);
  const files = [...input.files].slice(0, room);
  input.value = '';
  if (!files.length) { toast('You can add up to ' + MAX_PHOTOS + ' photos per listing'); return; }
  const tok = pickTok;
  readingImgs += files.length; drawPending();
  for (const f of files) {
    try {
      const d = await storePhoto(await readImage(f, 1200), 'listings');
      if (tok === pickTok) pendingImgs.push(d);
    } catch (err) { toast(err.message); }
    if (tok === pickTok) readingImgs--;
    drawPending();
  }
}
function drawPending() {
  const el = document.getElementById('pendpreview'); if (!el) return;
  el.innerHTML = pendingImgs.map((s, i) => `<div class="pthumb"><img src="${s}" alt=""><button type="button" onclick="dropPending(${i})">×</button></div>`).join('')
    + (readingImgs > 0 ? '<span class="muted">Loading ' + readingImgs + ' photo(s)...</span>' : '');
}
function dropPending(i) { pendingImgs.splice(i, 1); drawPending(); }
function removeSavedImg(lid, i) {
  const l = listingById(lid), u = me();
  if (!l || !u || (l.sellerId !== u.id && !u.isAdmin)) return;
  if (!l.images || !l.images[i]) return;
  deletePhotoObject(l.images[i]); l.images.splice(i, 1); save(); toast('Photo removed'); render();
}
async function pickVerifyDoc(input) {
  const f = input.files[0]; input.value = '';
  if (!f) return;
  const tok = pickTok;
  docReading++; drawDoc();
  try {
    // ID docs are never uploaded to the public bucket. The base64 image lives only in the verifyRequests row (RLS: owner + admin)
    const d = await readImage(f, 1200);
    if (tok === pickTok) docData = d;
  } catch (err) { toast(err.message); }
  if (tok === pickTok) docReading--;
  drawDoc();
}
function drawDoc() {
  const el = document.getElementById('docprev'); if (!el) return;
  el.innerHTML = docData ? `<img class="docprev" src="${docData}" alt="Your document">` : (docReading > 0 ? '<span class="muted">Loading picture...</span>' : '');
}

// ===== LISTINGS =====
function readListing(f) {
  const v = {
    title: fv(f, 'title').trim(), desc: fv(f, 'desc').trim(), category: fv(f, 'category'),
    price: num(fv(f, 'price')), discount: fv(f, 'discount').trim() ? num(fv(f, 'discount')) : 0,
    photo: fv(f, 'photo').trim()
  };
  if (!v.title) v.err = 'Please enter a title';
  else if (!(v.price > 0)) v.err = 'Enter a valid price in ₦';
  else if (v.discount && !(v.discount > 0 && v.discount < v.price)) v.err = 'Discount price must be lower than the normal price';
  return v;
}
// listing limit: admin sets listingLimit on the user row (blank/undefined = unlimited)
function listingCount(uid) { return db.listings.filter(l => l.sellerId === uid).length; }
function limitText(u) { return u && u.listingLimit != null && u.listingLimit !== '' ? String(u.listingLimit) : 'unlimited'; }
function postListing(e) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('sell');
  if (blockSusp(u)) return false;
  if (u.listingLimit != null && u.listingLimit !== '' && listingCount(u.id) >= Number(u.listingLimit)) {
    toast('Listing limit reached (' + u.listingLimit + '). Contact support to increase it.'); return false;
  }
  if (readingImgs > 0) { toast('Photos are still loading, wait a moment'); return false; }
  const v = readListing(e.target);
  if (v.err) { toast(v.err); return false; }
  const l = Object.assign({ id: uid(), sellerId: u.id, ownerId: u.ownerId || '', created: nowMs(), images: pendingImgs.slice() }, v); delete l.err;
  db.listings.unshift(l); save();
  resetPending();
  toast('Your item is listed!');
  location.hash = '#/item/' + l.id;
  return false;
}
function saveListing(e, id) {
  e.preventDefault();
  const l = listingById(id), u = me();
  if (!l || !u || (l.sellerId !== u.id && !u.isAdmin)) { toast('You can only edit your own listings'); return false; }
  if (readingImgs > 0) { toast('Photos are still loading, wait a moment'); return false; }
  const v = readListing(e.target);
  if (v.err) { toast(v.err); return false; }
  delete v.err;
  v.images = (l.images || []).concat(pendingImgs).slice(0, MAX_PHOTOS);
  Object.assign(l, v); save();
  resetPending();
  toast('Listing updated');
  location.hash = '#/item/' + id;
  return false;
}
function deleteListing(id) {
  const l = listingById(id), u = me();
  if (!l || !u || (l.sellerId !== u.id && !u.isAdmin)) { toast('You can only delete your own listings'); return; }
  if (!confirm('Delete "' + l.title + '"? This cannot be undone.')) return;
  (l.images || []).forEach(deletePhotoObject); deletePhotoObject(l.photo);
  db.listings = db.listings.filter(x => x.id !== id);
  db.comments = db.comments.filter(c => c.listingId !== id);
  db.reactions = db.reactions.filter(r => r.listingId !== id);
  save(); toast('Listing deleted');
  location.hash = u.isAdmin && l.sellerId !== u.id ? '#/admin' : '#/me';
}

// ===== COMMENTS & DMs =====
function postComment(e, lid) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('item/' + lid);
  if (blockSusp(u)) return false;
  const t = fv(e.target, 'text').trim();
  if (!t) return false;
  db.comments.push({ id: uid(), listingId: lid, userId: u.id, ownerId: u.ownerId || '', text: t, at: nowMs() });
  save(); e.target.reset(); render();
  return false;
}
function sendDM(e, other) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('messages/' + other);
  if (blockSusp(u)) return false;
  const t = fv(e.target, 'text').trim();
  if (!t) return false;
  // DMs are private: ownerId = sender's auth id, targetOwner = recipient's auth id (RLS: only these two read the row)
  db.messages.push({ id: uid(), from: u.id, to: other, ownerId: u.ownerId || '', targetOwner: (byId(other) || {}).ownerId || '', text: t, at: nowMs(), readBy: [u.id] });
  save(); e.target.reset(); render();
  return false;
}

// ===== VERIFICATION =====
function requestVerify(e) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('verify');
  if (u.verified) { toast('You are already verified'); return false; }
  if (db.verifyRequests.some(r => r.userId === u.id && r.status === 'pending')) { toast('You already have a pending request'); return false; }
  if (docReading > 0) { toast('Your picture is still loading, wait a moment'); return false; }
  if (!docData) { toast('Please upload a photo of your ID or passport first'); return false; }
  db.verifyRequests.unshift({ id: uid(), userId: u.id, ownerId: u.ownerId || '', ref: fv(e.target, 'ref').trim(), doc: docData, status: 'pending', at: nowMs() });
  docData = '';
  save(); toast('Sent to admin with your document. Verification is usually done after the admin checks the payment.'); render();
  return false;
}
function setListingLimit(userId) {
  const u = byId(userId); if (!u) return;
  const el = document.getElementById('limit-' + userId); if (!el) return;
  const raw = String(el.value).trim();
  if (raw === '') { delete u.listingLimit; }
  else {
    const n = Math.floor(Number(raw));
    if (!(n >= 0) || !isFinite(n)) { toast('Enter a whole number, or leave blank for unlimited'); return; }
    u.listingLimit = n;
  }
  save(); toast(u.name + ' listing limit: ' + limitText(u)); render();
}
function setVerified(userId, val) {
  const u = byId(userId); if (!u) return;
  u.verified = val;
  db.verifyRequests.forEach(r => { if (r.userId === userId && r.status === 'pending') r.status = val ? 'approved' : 'rejected'; });
  save(); toast(val ? u.name + ' is now verified' : 'Verification removed'); render();
}
function rejectRequest(id) {
  const r = db.verifyRequests.find(x => x.id === id); if (!r) return;
  r.status = 'rejected'; save(); toast('Request rejected'); render();
}
function resetAll() {
  if (!confirm('Erase ALL data on this browser (accounts, listings, messages)? This cannot be undone.')) return;
  localStorage.removeItem(KEY); db = seed(); init(); toast('All data reset'); location.hash = '#/';
}

// ===== PROFILE =====
function saveProfile(e) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('profile/edit');
  const f = e.target;
  u.name = fv(f, 'name').trim() || u.name;
  u.phone = fv(f, 'phone').trim();
  u.wa = fv(f, 'wa').trim();
  u.location = fv(f, 'place').trim();
  u.bio = fv(f, 'bio').trim();
  u.info = fv(f, 'info').trim();
  const link = fv(f, 'photo').trim();
  if (pendingAvatar) { u.photo = pendingAvatar; pendingAvatar = ''; }
  else if (link) u.photo = link;
  save(); toast('Profile saved'); location.hash = '#/me';
  return false;
}
function avatar(u) {
  if (u.photo) return `<img class="av" src="${esc(u.photo)}" alt="">`;
  return `<div class="av">${esc((u.name || '?').charAt(0).toUpperCase())}</div>`;
}
function doPeople(e) {
  e.preventDefault();
  const v = fv(e.target, 'q').trim();
  location.hash = '#/people?q=' + encodeURIComponent(v);
  return false;
}

// ===== NAV / CHROME =====
// logged-out visitors can browse listings; these pages need an account
const NEEDS_LOGIN = ['sell', 'checkout', 'me', 'profile', 'messages', 'verify', 'order', 'people', 'notifs', 'user'];
function updateChrome() {
  const u = me();
  document.body.classList.toggle('loggedout', !u);
  const acct = document.getElementById('acct');
  acct.textContent = u ? 'Hi, ' + u.name.split(' ')[0] : 'Login / Register';
  acct.href = u ? '#/me' : '#/login';
  // logged-out: People, notifications and Inbox links do not exist in the DOM at all
  const authEl = document.getElementById('authlinks');
  if (authEl) authEl.innerHTML = u ? '<a href="#/notifs" class="tn-link" aria-label="Notifications">🔔<span class="fbadge" id="nbadge" hidden></span></a> <a href="#/messages" class="tn-link">Inbox<span class="fbadge" id="ubadge-top" hidden></span></a>' : '';
  const route = (location.hash || '#/').slice(2).split(/[/?]/)[0] || 'home';
  // market page shows only its two tabs (no category chip row)
  document.getElementById('catbar').innerHTML = (route === 'general' || route === 'home' || route === '') ? '' : CATS.map(c => `<a href="#/cat/${encodeURIComponent(c)}">${esc(c)}</a>`).join('');
  const items = [['home', '#/', '🏠', 'Home'], ['messages', '#/messages', '💬', 'Inbox'], ['sell', '#/sell', '＋', 'Sell'], ['requests', '#/requests', '🔔', 'Requests'], ['me', '#/me', '👤', 'Account']];
  document.getElementById('bottomnav').innerHTML = !u ? '' : items.map(([k, h, i, t]) => `<a href="${h}" class="${route === k || (k === 'cats' && route === 'cat') ? 'on' : ''}"><span class="i">${i}</span>${t}${k === 'requests' && u && pendingRequestsFor(u.id).length ? `<span class="fbadge">${pendingRequestsFor(u.id).length}</span>` : ''}</a>`).join('');
}
function doSearch(e) {
  e.preventDefault();
  const v = document.getElementById('q').value.trim();
  location.hash = '#/search?q=' + encodeURIComponent(v);
  return false;
}

// ===== PAGES =====
function authToggle(active) {
  return `<div class="authtoggle"><a href="#/register" class="${active === 'register' ? 'on' : ''}">Sign Up</a><a href="#/login" class="${active === 'login' ? 'on' : ''}">Login</a></div>`;
}
function authCard(active, inner) {
  return `<div class="authwrap"><div class="authcard">${authToggle(active)}${inner}</div></div>`;
}
function pageLogin(q) {
  window.NEXT = q.get('next') || 'me';
  return authCard('login', `<h2 class="authh">Welcome back</h2>
    <p class="authsub">Log in with your email and password to continue to your LOCAL MARKET account.</p>
    <form onsubmit="return doLogin(event)" class="authform">
      <label class="authlab">Email address<input class="authin" name="email" type="email" required autocomplete="email" placeholder="name@example.com"></label>
      <label class="authlab">Password<input class="authin" name="password" id="lpw" type="password" required autocomplete="current-password" placeholder="Enter your password"></label>
      <label class="checkline"><input type="checkbox" onchange="var p=document.getElementById('lpw');p.type=this.checked?'text':'password'"> Show password</label>
      <button class="authbtn" type="submit">Log in</button>
    </form>
    <p class="authlink"><a href="#" onclick="return toggleForgot()">Forgot password?</a></p>
    <form id="forgotform" onsubmit="return doForgot(event)" class="authform" style="display:none">
      <label class="authlab">Email address on your account<input class="authin" name="email" type="email" required autocomplete="email" placeholder="name@example.com"></label>
      <button class="authbtn" type="submit">Send reset link</button>
    </form>
    <p class="authlink">New here? <a href="#/register">Create account &gt;</a></p>`);
}
function toggleForgot() {
  const f = document.getElementById('forgotform');
  if (f) f.style.display = f.style.display === 'none' ? 'flex' : 'none';
  return false;
}
// Supabase Auth recovery email. Same message on success, so it does not reveal which emails have accounts.
async function doForgot(e) {
  e.preventDefault();
  const email = fv(e.target, 'email').trim();
  if (!email) return false;
  const r = await sbAuth('recover', { email });
  if (r.ok) toast('If that email is on an account, a reset link was sent.');
  else toast('Could not send a reset link. Ask the admin to reset your password in the Supabase dashboard.');
  return false;
}
function pageRegister() {
  return authCard('register', `<h2 class="authh">Create account</h2>
    <p class="authsub">Set up your LOCAL MARKET account to list items, chat with buyers and get verified.</p>
    <form onsubmit="return doRegister(event)" class="authform">
      <label class="authlab">Full name<input class="authin" name="name" required placeholder="Enter your full name"></label>
      <label class="authlab">Email address<input class="authin" name="email" type="email" required autocomplete="email" placeholder="name@example.com"></label>
      <label class="authlab">Password<input class="authin" name="password" id="rpw" type="password" minlength="6" required autocomplete="new-password" placeholder="Create a password (6+ characters)"></label>
      <label class="checkline"><input type="checkbox" onchange="var p=document.getElementById('rpw');p.type=this.checked?'text':'password'"> Show password</label>
      <div class="authopt">Optional</div>
      <label class="authlab small">Phone number<input class="authin sm" name="phone" type="tel" placeholder="e.g. 08012345678"></label>
      <label class="authlab small">Location / city<input class="authin sm" name="place" placeholder="e.g. Kaduna"></label>
      <button class="authbtn" type="submit">Create account</button>
    </form>
    <p class="authlink">Already have an account? <a href="#/login">Login &gt;</a></p>`);
}
function notificationsFor(u) {
  if (!u) return [];
  const mine = db.listings.filter(l => l.sellerId === u.id).map(l => l.id);
  const out = [];
  db.reactions.forEach(r => {
    if (mine.includes(r.listingId) && r.userId !== u.id) {
      const who = byId(r.userId), it = listingById(r.listingId);
      const def = REACTS.find(x => x[0] === r.reaction);
      out.push({ at: r.at || 0, html: `${who ? esc(who.name) : 'Someone'} reacted ${def ? def[1] : '❤️'} on <a href="#/item/${r.listingId}">${it ? esc(it.title) : 'your item'}</a>` });
    }
  });
  db.comments.forEach(c => {
    if (mine.includes(c.listingId) && c.userId !== u.id) {
      const who = byId(c.userId), it = listingById(c.listingId);
      out.push({ at: c.at || 0, html: `${who ? esc(who.name) : 'Someone'} commented on <a href="#/item/${c.listingId}">${it ? esc(it.title) : 'your item'}</a>: ${esc((c.text || '').slice(0, 60))}` });
    }
  });
  (db.follows || []).filter(f => f.following === u.id && f.status === 'pending').forEach(f => {
    const who = byId(f.follower);
    out.push({ at: f.at || 0, html: `${who ? esc(who.name) : 'Someone'} sent u a follow request <a href="#/user/${f.follower}">view</a>` });
  });
  return out.sort((a, b) => b.at - a.at);
}
function pageNotifs() {
  const u = me();
  if (!u) return `<div class="page empty"><h1>Notifications</h1><p>Login to see notifications.</p><a class="btn" href="#/login?next=notifs">Login</a></div>`;
  const list = notificationsFor(u);
  window.NOTIF_SEEN = Date.now();
  return `<div class="page"><h1>Notifications</h1>
    ${list.map(n => `<div class="convo"><div style="flex:1">${n.html}<div class="muted">${when(n.at)}</div></div></div>`).join('') || '<p class="muted">No notifications yet. They appear when someone reacts to or comments on your items.</p>'}</div>`;
}
function pageGeneral(tab) {
  const u = me();
  const following = tab === 'following';
  const folIds = u ? followingOf(u.id).map(x => x.id) : [];
  const tabs = `<div class="mtabs"><a href="#/general" class="${following ? '' : 'on'}">General Market</a>`
    + `<a href="${u ? '#/general?tab=following' : '#/login?next=general'}" class="${following ? 'on' : ''}">From People You Follow</a></div>`;
  const cats = '';
  if (following) {
    if (!u) return `<div class="page">${tabs}${cats}<p class="muted">Log in to see listings from people you follow.</p><p><a class="btn" href="#/login?next=general%3Ftab%3Dfollowing">Login</a></p></div>`;
    const fromFol = db.listings.filter(l => folIds.includes(l.sellerId)).sort((a, b) => b.created - a.created);
    return `<div class="page"><h1>Market</h1>${tabs}${cats}
      <h2 class="sec">From people you follow <small>${fromFol.length} items</small></h2>
      ${grid(fromFol, folIds.length ? 'Nobody you follow has listed anything yet.' : 'Follow people (mutual after they accept) and their items show here.')}</div>`;
  }
  const latest = db.listings.slice().sort((a, b) => b.created - a.created).slice(0, 60);
  const popular = db.listings.filter(l => likeCount(l.id) > 0)
    .sort((a, b) => likeCount(b.id) - likeCount(a.id) || b.created - a.created).slice(0, 6);
  return `<div class="page"><h1>Market</h1>${tabs}${cats}
    <h2 class="sec">Suggested for you <small>Most liked items</small></h2>
    ${popular.length ? grid(popular) : '<div class="empty">No likes yet. Open any item and tap a reaction to start.</div>'}
    <h2 class="sec">Fresh on LOCAL MARKET <small>${db.listings.length} items</small></h2>
    ${grid(latest, 'No listings yet. Be the first to sell something.')}</div>`;
}

// facebook-style feed on the home page: one post per listing, newest first
function feedPost(l) {
  const s = byId(l.sellerId) || { name: 'Seller', id: '' };
  const cnt = reactCounts(l.id), mine = myReact(l.id), total = likeCount(l.id);
  const comments = db.comments.filter(c => c.listingId === l.id).sort((a, b) => a.at - b.at);
  const shown = comments.slice(-1); // home feed: only the newest comment inline; the rest show on the product page
  const u = me();
  return `<div class="fpost" id="fp-${l.id}">
    <div class="fphead">${avatar(s)}<div style="flex:1"><a href="#/user/${s.id}"><b>${esc(s.name)}</b></a>${tick(s)}
      <div class="muted">${when(l.created)}</div></div></div>
    <div class="fpcap">${esc(l.desc || '')}</div>
    <a href="#/item/${l.id}">${photoHTML(l, true)}</a>
    <div class="fpbody"><a href="#/item/${l.id}" class="fptitle">${esc(l.title)}</a> <span class="fpprice">${priceHTML(l, false)}</span></div>
    <div class="fpstat muted">${total} reaction${total === 1 ? '' : 's'} · ${comments.length} comment${comments.length === 1 ? '' : 's'}</div>
    <div class="fpact">${REACTS.map(([k, e, t]) => `<button class="fpbtn ${mine === k ? 'on' : ''}" title="${t}" onclick="feedReact('${l.id}','${k}')">${e} ${cnt[k] || ''}</button>`).join('')}
      <button class="fpbtn" onclick="fpToggleComment('${l.id}')">💬 Comment</button></div>
    ${shown.map(c => { const cu = byId(c.userId); return `<div class="cmt"><b><a href="#/user/${c.userId}">${esc(cu ? cu.name : 'User')}</a></b> <span class="muted">· ${when(c.at)}</span><div>${esc(c.text)}</div></div>`; }).join('')}
    ${comments.length > 1 ? `<a class="muted" href="#/item/${l.id}">View all ${comments.length} comments</a>` : ''}
    ${u ? `<form class="fpcform" id="fcw-${l.id}" style="display:none" onsubmit="return feedComment(event,'${l.id}')"><input id="fc-${l.id}" name="text" placeholder="Write a comment…" required autocomplete="off"><button class="btn small" type="submit">Post</button></form>`
      : `<p class="muted"><a href="#/login">Log in</a> to comment.</p>`}
  </div>`;
}
function feedHTML(tab) {
  const u = me();
  const following = tab === 'following' && u;
  const folIds = u ? followingOf(u.id).map(x => x.id) : [];
  let list = db.listings.slice().sort((a, b) => b.created - a.created);
  if (following) list = list.filter(l => folIds.includes(l.sellerId));
  if (!list.length) return `<div class="muted">${following ? 'Nobody you follow has listed anything yet.' : 'No posts yet. Be the first to sell something.'}</div>`;
  const out = [];
  const sugg = u && !following ? peopleYouMayKnow(u) : [];
  let sIdx = 0;
  list.slice(0, 40).forEach((l, i) => {
    out.push(feedPost(l));
    const n = i + 1;
    if (sugg.length && (n === 2 || (n > 2 && (n - 2) % 3 === 0)) && sIdx < 1000) {
      out.push(pymkCard(sugg.slice(0, 3)));
      sugg.splice(0, 3);
    }
  });
  return out.join('');
}
function peopleYouMayKnow(u) {
  return db.users.filter(x => x.id !== u.id && !x.isAdmin && !followRec(u.id, x.id))
    .sort((a, b) => (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || followersOf(b.id).length - followersOf(a.id).length);
}
function pymkCard(people) {
  return `<div class="sec"><h2 class="sec">People you may know</h2><p class="sec muted">People you may want to follow</p><div class="hscroll">${people.map(p => `<div class="fbcard"><a href="#/user/${p.id}" class="fbcard-pic">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<div class="fbcard-ph">${esc((p.name || '?').charAt(0).toUpperCase())}</div>`}</a><div class="fbcard-body"><a href="#/user/${p.id}"><b>${esc(p.name)}</b></a>${badge(p)}<div class="muted">${followersOf(p.id).length} followers</div><button class="btn" style="width:100%" onclick="toggleFollow('${p.id}')">Follow</button></div></div>`).join('')}</div></div>`;
}
function fpToggleComment(lid) {
  const w = document.getElementById('fcw-' + lid);
  if (!w) return false;
  w.style.display = w.style.display === 'none' ? 'flex' : 'none';
  if (w.style.display !== 'none') { const i = document.getElementById('fc-' + lid); if (i) i.focus(); }
  return false;
}
function feedReact(lid, type) {
  const u = me(); if (!u) return needLogin('?');
  if (blockSusp(u)) return false;
  react(lid, type);
  return false;
}
function feedComment(e, lid) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('?');
  if (blockSusp(u)) return false;
  const t = fv(e.target, 'text').trim();
  if (!t) return false;
  db.comments.push({ id: uid(), listingId: lid, userId: u.id, ownerId: u.ownerId || '', text: t, at: nowMs() });
  save(); render();
  return false;
}
function pageHome(tab) {
  const me0 = me();
  const reqs = me0 ? pendingRequestsFor(me0.id) : [];
  const folTab = me0 && tab === 'following' ? 'following' : '';
  const tabs = `<div class="mtabs"><a href="#/?tab=all" class="${folTab ? '' : 'on'}">General Market</a><a href="${me0 ? '#/?tab=following' : '#/login?next=general'}" class="${folTab ? 'on' : ''}">From People You Follow</a></div>`;
  const feedSec = `<h2 class="sec">Feed <small>${folTab ? 'from people you follow' : 'every new listing'}</small></h2>${me0 ? feedHTML(folTab) : ''}`;
  const popular = db.listings.filter(l => likeCount(l.id) > 0)
    .sort((a, b) => likeCount(b.id) - likeCount(a.id) || b.created - a.created).slice(0, 6);
  const pymk = me0 ? peopleYouMayKnow(me0).slice(0, 10) : [];
  const suggHTML = pymk.length ? `<div class="hscroll">${pymk.map(p => `<div class="fbcard"><a href="#/user/${p.id}" class="fbcard-pic">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<div class="fbcard-ph">${esc((p.name || '?').charAt(0).toUpperCase())}</div>`}</a><div class="fbcard-body"><a href="#/user/${p.id}"><b>${esc(p.name)}</b></a>${badge(p)}<div class="muted">${followersOf(p.id).length} followers</div><button class="btn" style="width:100%" onclick="toggleFollow('${p.id}')">Follow</button></div></div>`).join('')}</div>` : '<p class="muted">No people to suggest yet.</p>';
  return `<section class="hero"><h1>Buy and sell anything on LOCAL MARKET</h1>
    <p>Post your items in minutes, chat with buyers, agree a price, then pay the seller directly. Verified sellers show a ✔ badge.</p>
    <div class="herobtns"><a class="btn" href="#/general">General Market</a><a class="btn ghost" href="#/sell">Start selling</a></div></section>
    ${tabs}
    ${me0 ? feedSec : ''}
    ${me0 ? `<h2 class="sec">People you may know</h2><p class="sec muted">People you may want to follow</p>${suggHTML}` : ''}`;
}
function pageRequests() {
  const me0 = me();
  if (!me0) return needLogin('requests');
  const reqs = pendingRequestsFor(me0.id);
  return `<div class="page"><h1>Follow requests <small>${reqs.length}</small></h1>${reqs.map(p => `<div class="convo">${avatar(p).replace('class="av"', 'class="av" style="width:44px;height:44px;font-size:18px"')}<div style="flex:1"><b>${esc(p.name)}</b>${badge(p)}<div class="btnrow"><button class="btn" onclick="acceptFollow('${p.id}')">Accept</button><button class="btn ghost" onclick="declineFollow('${p.id}')">Decline</button></div></div></div>`).join('') || '<p class="muted">No pending follow requests.</p>'}</div>`;
}
function pageCats() {
  return `<div class="page"><h1>Categories</h1><div class="cats-grid" style="padding:0">${CATS.map(c => `<a class="catchip" href="#/cat/${encodeURIComponent(c)}">${CAT_ICON[c]} ${esc(c)} (${db.listings.filter(l => l.category === c).length})</a>`).join('')}</div></div>`;
}
function pageCat(name) {
  const list = rankFor(db.listings.filter(l => l.category === name));
  const note = me() ? 'Your own items come first, then people you follow, then everyone else.' : 'Newest items first.';
  return `<h2 class="sec">${CAT_ICON[name] || ''} ${esc(name)} <small>${list.length} items</small></h2><p class="sec muted">${note}</p>${grid(list, 'No items in this category yet.')}`;
}
function pageSearch(q) {
  const s = q.toLowerCase().trim();
  const listings = s ? db.listings.filter(l => (l.title + ' ' + l.desc + ' ' + l.category).toLowerCase().includes(s)) : [];
  // universal search: people (logged-in only) + products on one page
  const people = s && me() ? db.users.filter(x => (x.name || '').toLowerCase().includes(s)) : [];
  const peopleHTML = !s ? '' : !me()
    ? '<p class="sec muted">Login to see people results. <a href="#/login?next=search">Login</a></p>'
    : `<h3 class="sec">People <small>${people.length}</small></h3>${people.map(personRow).join('') || '<p class="muted">No people found.</p>'}`;
  return `<h2 class="sec">Search: "${esc(q)}" <small>${listings.length} products</small></h2>
    ${s ? peopleHTML : ''}
    ${s ? '<h3 class="sec">Products <small>' + listings.length + '</small></h3>' + grid(listings, 'No products match. Try another word.') : '<div class="empty">Type something in the search bar.</div>'}`;
}
function pagePeople(q) {
  if (!me()) return `<div class="page empty"><h1>People</h1><p>Login to see people.</p><a class="btn" href="#/login?next=people">Login</a></div>`;
  const s = q.toLowerCase().trim();
  const list = s ? db.users.filter(x => (x.name || '').toLowerCase().includes(s)) : [];
  return `<div class="page"><h1>Find people</h1>
    <form class="cform" onsubmit="return doPeople(event)"><input name="q" value="${esc(q)}" placeholder="Type a name, e.g. Salihu" autocomplete="off"><button class="btn" type="submit">Search people</button></form>
    <h3>${s ? list.length + ' result(s) for "' + esc(q) + '"' : 'Type a name to search'}</h3>
    ${list.map(personRow).join('') || (s ? '<p class="muted">No one found with that name.</p>' : '')}</div>`;
}
function pageItem(id) {
  const l = listingById(id);
  if (!l) return `<div class="page empty">This listing no longer exists. <a href="#/">Back to home</a></div>`;
  const s = byId(l.sellerId) || { name: 'Seller', id: '' };
  const u = me();
  const own = u && u.id === l.sellerId;
  const comments = db.comments.filter(c => c.listingId === id).sort((a, b) => a.at - b.at);
  const pct = l.discount && l.discount < l.price ? Math.round((1 - l.discount / l.price) * 100) : 0;
  const imgs = (l.images || []);
  return `<div class="page item">
    <div class="itemtop">
      <div>${gallery(l)}</div>
      <div>
        <div class="cat">${CAT_ICON[l.category] || ''} ${esc(l.category)}</div>
        <h1>${esc(l.title)}</h1>
        <div class="bigprice">${priceHTML(l, true)} ${pct ? `<span class="pct">-${pct}% off</span>` : ''}</div>
        <div class="sellerbox">Sold by <a href="#/user/${s.id}">${esc(s.name)}</a>${badge(s)}</div>
        ${own ? `<div class="btnrow"><a class="btn ghost" href="#/sell/${l.id}">Edit price / details / photos</a><button class="btn ghost" onclick="deleteListing('${l.id}')">Delete listing</button></div>`
          : `<div class="btnrow"><a class="btn" href="#/messages/${s.id}?item=${l.id}">Buy / Chat with seller</a></div>`}
        ${reactBar(l)}
        <h3>Description</h3><div class="desc">${esc(l.desc) || 'No description.'}</div>
        ${imgs.length > 1 ? `<p class="muted">${imgs.length} photos</p>` : ''}
      </div>
    </div>
    <h3>Comments & questions (${comments.length})</h3>
    <p class="muted">Ask the seller questions or agree a deal here. Agree the price in chat. After you agree, the seller sends their account number for payment.</p>
    ${comments.map(c => { const cu = byId(c.userId); return `<div class="cmt"><b><a href="#/user/${c.userId}">${esc(cu ? cu.name : 'User')}</a></b>${tick(cu)} ${c.userId === l.sellerId ? '<span class="sellertag">Seller</span>' : ''} <span class="muted">· ${when(c.at)}</span><div>${esc(c.text)}</div></div>`; }).join('') || '<p class="muted">No comments yet.</p>'}
    ${u ? `<form class="cform" onsubmit="return postComment(event,'${l.id}')"><textarea name="text" placeholder="Write a comment or question" required></textarea><button class="btn small" style="align-self:flex-start">Post comment</button></form>`
      : `<p><a href="#/login?next=${encodeURIComponent('item/' + l.id)}">Log in</a> to comment.</p>`}
  </div>`;
}
function listingForm(l) {
  l = l || { title: '', desc: '', category: CATS[0], price: '', discount: '', photo: '', images: [] };
  const saved = l.id ? (l.images || []) : [];
  const existing = saved.length + (l.photo ? 1 : 0);
  return `<form class="cform" onsubmit="return ${l.id ? 'saveListing(event,\'' + l.id + '\')' : 'postListing(event)'}">
    <label>Title<input name="title" required value="${esc(l.title)}" placeholder="e.g. Used iPhone 11 64GB"></label>
    <label>Category<select name="category">${CATS.map(c => `<option ${c === l.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <label>Normal price (₦)<input name="price" required inputmode="numeric" value="${l.price || ''}" placeholder="e.g. 150000"></label>
    <label>Discount price (₦) <span class="muted">optional, leave blank for none</span><input name="discount" inputmode="numeric" value="${l.discount || ''}" placeholder="e.g. 130000"></label>
    <label>Description<textarea name="desc" rows="4" placeholder="Condition, size, delivery, warranty">${esc(l.desc)}</textarea></label>
    <div class="photobox"><b>Photos from your phone gallery</b> <span class="muted">pick one or more pictures (up to ${MAX_PHOTOS} per listing)</span>
      ${saved.length ? `<div class="thumbs">${saved.map((s, i) => `<div class="pthumb"><img src="${esc(s)}" alt=""><button type="button" onclick="removeSavedImg('${l.id}',${i})">×</button></div>`).join('')}</div>` : ''}
      <input type="file" accept="image/*" multiple onchange="pickPhotos(this,${existing})">
      <div id="pendpreview" class="thumbs"></div>
    </div>
    <label>Photo link (optional) <span class="muted">or paste an image web address</span><input name="photo" value="${esc(l.photo)}" placeholder="https://..."></label>
    <button class="btn big" type="submit">${l.id ? 'Save changes' : 'Publish listing'}</button>
  </form>`;
}
function pageSell(id) {
  const u = me();
  if (!u) return `<div class="page empty">Please <a href="#/login?next=sell">log in</a> or <a href="#/register">create an account</a> to sell.</div>`;
  if (!id) return `<div class="page"><h1>Sell an item</h1>${listingForm()}</div>`;
  const l = listingById(id);
  if (!l || (l.sellerId !== u.id && !u.isAdmin)) return `<div class="page empty">You can only edit your own listings.</div>`;
  return `<div class="page"><h1>Edit listing</h1>${listingForm(l)}
    <div class="btnrow"><button class="btn ghost" onclick="deleteListing('${l.id}')">Delete this listing</button></div></div>`;
}
function pageMe() {
  const u = me();
  if (!u) return needLogin('me') && '';
  const mine = db.listings.filter(l => l.sellerId === u.id);
  const vr = db.verifyRequests.find(r => r.userId === u.id);
  return `<div class="page">
    <div class="profilehead">${avatar(u)}<div><h1 style="margin:0">${esc(u.name)}${badge(u)}</h1>
      <div class="muted">${esc(u.location) || 'Location not set'} · ${esc(u.phone) || 'phone not set'}</div></div></div>
    <div class="fstats"><span><b>${mine.length}</b> items</span><span><b>${followersOf(u.id).length}</b> followers</span><span><b>${followingOf(u.id).length}</b> following</span></div>
    <p class="muted">Listing limit: <b>${esc(limitText(u))}</b>${u.listingLimit != null && u.listingLimit !== '' ? ' (' + mine.length + ' used)' : ''}</p>
    <div class="btnrow"><a class="btn ghost" href="#/profile/edit">Edit profile</a><a class="btn ghost" href="#/user/${u.id}">View my public profile</a>${u.verified ? '' : '<a class="btn" href="#/verify">Get verified</a>'}${u.isAdmin ? '<a class="btn ghost" href="#/admin">Admin panel</a>' : ''}</div>
    ${u.bio ? `<p>${esc(u.bio)}</p>` : ''}
    ${u.info ? `<p class="muted">${esc(u.info)}</p>` : ''}
    ${vr && vr.status === 'pending' ? '<p class="pill">Verification payment under review</p>' : ''}
    <h3>My listings (${mine.length})</h3>
    ${mine.length ? `<div class="grid inner">${mine.map(l => `<div>${card(l)}<a class="btn small" style="margin-top:6px;display:inline-block" href="#/sell/${l.id}">Edit</a></div>`).join('')}</div>` : '<p class="muted">You have not listed anything yet. <a href="#/sell">Sell an item</a></p>'}
    <h3>Change password</h3>
    <form class="cform" onsubmit="return changePassword(event)">
      <label>Current password (optional)<input name="current" type="password" autocomplete="current-password" placeholder="Your current password"></label>
      <label>New password (6+ characters)<input name="password" type="password" minlength="6" required autocomplete="new-password" placeholder="New password"></label>
      <button class="btn" type="submit">Change password</button>
    </form>
    <div style="margin-top:28px;text-align:center"><button class="btn ghost" onclick="logout()">Log out</button></div>
  </div>`;
}
// PATCH /auth/v1/user with the logged-in access token. If a current password is typed, it is checked first.
async function changePassword(e) {
  e.preventDefault();
  const u = me(); if (!u) return needLogin('me');
  const f = e.target;
  const current = fv(f, 'current'), pw = fv(f, 'password');
  if (pw.length < 6) { toast('New password must be at least 6 characters.'); return false; }
  if (current && u.phone) {
    const chk = await sbAuth('token?grant_type=password', { phone: normPhone(u.phone), password: current });
    if (!chk.ok || !chk.data.access_token) { toast('Current password is wrong.'); return false; }
  }
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': 'Bearer ' + sbToken() }, body: JSON.stringify({ password: pw }) });
    if (r.ok) { f.reset(); toast('Password changed.'); }
    else { let j = {}; try { j = await r.json(); } catch (x) {} toast('Could not change password: ' + (j.msg || j.error_description || j.message || r.status)); }
  } catch (x) { toast('Network error. Check your connection.'); }
  return false;
}
function pageEditProfile() {
  const u = me();
  if (!u) return needLogin('profile/edit') && '';
  return `<div class="page"><h1>Edit profile</h1>
    <form class="cform" onsubmit="return saveProfile(event)">
      <label>Full name<input name="name" required value="${esc(u.name)}"></label>
      <label>Phone<input name="phone" value="${esc(u.phone)}"></label>
      <label>WhatsApp number or link (buyers can reach u there)<input name="wa" value="${esc(u.wa || '')}" placeholder="08012345678 or https://wa.me/23480123456789"></label>
      <label>Location<input name="place" value="${esc(u.location)}"></label>
      <label>Bio (a short line about you)<textarea name="bio" rows="3">${esc(u.bio)}</textarea></label>
      <label>More info (delivery area, hours, anything buyers should know)<textarea name="info" rows="3">${esc(u.info)}</textarea></label>
      <div class="photobox"><b>Profile picture</b> <span class="muted">choose a picture from your phone gallery</span>
        <div id="avprev" style="margin:8px 0">${avatar(u)}</div>
        <input type="file" accept="image/*" onchange="pickAvatar(this)"></div>
      <label>Or photo link (optional)<input name="photo" value="${esc(u.photo && u.photo.indexOf('data:') === 0 ? '' : u.photo)}" placeholder="https://..."></label>
      <button class="btn big" type="submit">Save profile</button>
    </form></div>`;
}
function pageUser(id) {
  const p = byId(id);
  if (!p) return `<div class="page empty">User not found.</div>`;
  const u = me();
  const list = db.listings.filter(l => l.sellerId === id);
  const fers = followersOf(id), fing = followingOf(id);
  const isMe = u && u.id === id;
  const amFollowing = u && isFollowing(u.id, id);
  const amRequested = u && isRequested(u.id, id);
  const theyRequested = u && isRequested(id, u.id);
  const followBtn = isMe ? '' : (u
    ? (amFollowing ? `<button class="btn ghost" onclick="toggleFollow('${id}')">Following (tap to unfollow)</button>`
      : amRequested ? `<button class="btn ghost" onclick="toggleFollow('${id}')">Requested (tap to cancel)</button>`
      : theyRequested ? `<button class="btn" onclick="acceptFollow('${id}')">Accept their follow request</button> <button class="btn ghost" onclick="declineFollow('${id}')">Decline</button>`
      : `<button class="btn" onclick="toggleFollow('${id}')">Follow</button>`)
    : `<a class="btn" href="#/login?next=${encodeURIComponent('user/' + id)}">Log in to follow</a>`);
  return `<div class="page"><div class="profilehead">${avatar(p)}<div><h1 style="margin:0">${esc(p.name)}${badge(p)}</h1>
    <div class="muted">${esc(p.location) || 'Location not set'}</div></div></div>
    <div class="fstats"><span><b>${list.length}</b> items</span><span><b>${fers.length}</b> followers</span><span><b>${fing.length}</b> following</span></div>
    ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
    ${p.info ? `<p class="muted">${esc(p.info)}</p>` : ''}
    <p>Phone: ${u ? esc(p.phone) || 'not set' : '<a href="#/login">Log in</a> to see contact details'}</p>
    ${waLink(p) && !isMe ? `<a class="btn" style="background:#25d366;color:#fff" href="${waLink(p)}" target="_blank" rel="noopener">💬 Chat on WhatsApp</a>` : ''}
    <div class="btnrow">${followBtn}${u && u.id !== p.id ? `<a class="btn ghost" href="#/messages/${p.id}">Send message</a>` : ''}${isMe ? '<a class="btn ghost" href="#/profile/edit">Edit profile</a>' : ''}</div>
    ${isMe && pendingRequestsFor(u.id).length ? `<h3>Follow requests (${pendingRequestsFor(u.id).length})</h3>${pendingRequestsFor(u.id).map(p => `<div class="convo"><div style="flex:1"><b>${esc(p.name)}</b><div class="btnrow"><button class="btn" onclick="acceptFollow('${p.id}')">Accept</button><button class="btn ghost" onclick="declineFollow('${p.id}')">Decline</button></div></div></div>`).join('')}` : ''}
    <h3>Followers (${fers.length})</h3>
    ${fers.map(personRow).join('') || '<p class="muted">No followers yet.</p>'}
    <h3>Following (${fing.length})</h3>
    ${fing.map(personRow).join('') || '<p class="muted">Not following anyone yet.</p>'}
    <h3>Listings (${list.length})</h3>${grid(list, 'No listings yet.')}</div>`;
}
function pageInbox() {
  const u = me();
  if (!u) return needLogin('messages') && '';
  const convoMap = {};
  db.messages.filter(m => m.from === u.id || m.to === u.id).forEach(m => {
    const other = m.from === u.id ? m.to : m.from;
    if (!convoMap[other] || convoMap[other].at < m.at) convoMap[other] = m;
  });
  const convos = Object.keys(convoMap).map(id => ({ id, m: convoMap[id] })).sort((a, b) => b.m.at - a.m.at);
  return `<div class="page"><h1>Inbox</h1>
    ${convos.map(c => { const o = byId(c.id); return `<a class="convo" href="#/messages/${c.id}">${avatar(o || { name: '?' }).replace('class="av"', 'class="av" style="width:44px;height:44px;font-size:18px"')}<div><b>${esc(o ? o.name : 'User')}</b>${badge(o)}<div class="muted">${esc(c.m.text).slice(0, 70)}</div></div><small>${when(c.m.at)}</small></a>`; }).join('')
    || '<div class="empty">No messages yet. Open any listing or profile and tap "Message seller" to start a chat.</div>'}</div>`;
}
function pageThread(id, q) {
  const u = me();
  if (!u) return needLogin('messages/' + id) && '';
  const other = byId(id);
  if (!other || other.id === u.id) return `<div class="page empty">User not found. <a href="#/messages">Back to inbox</a></div>`;
  markThreadRead(id);
  const it = q && q.get('item') ? listingById(q.get('item')) : null;
  const prefill = it ? 'Hi, I want to buy ' + it.title + ' at ' + naira(effective(it)) : '';
  const msgs = db.messages.filter(m => (m.from === u.id && m.to === id) || (m.from === id && m.to === u.id)).sort((a, b) => a.at - b.at);
  return `<div class="page"><h1 style="font-size:18px"><a href="#/messages">← Inbox</a> · ${avDot(other, 26)} ${esc(other.name)}${badge(other)}</h1>
    <div class="thread">${msgs.map(m => `<div class="bubble ${m.from === u.id ? 'me' : ''}">${esc(m.text)}<div class="when">${when(m.at)}</div></div>`).join('') || '<p class="muted">Say hello to start the chat.</p>'}</div>
    <form class="cform" onsubmit="return sendDM(event,'${id}')"><textarea name="text" placeholder="Type a message" required>${esc(prefill)}</textarea><button class="btn" style="align-self:flex-start">Send</button></form></div>`;
}
function pageVerify() {
  const u = me();
  if (!u) return needLogin('verify') && '';
  const pending = db.verifyRequests.find(r => r.userId === u.id && r.status === 'pending');
  const last = db.verifyRequests.find(r => r.userId === u.id);
  return `<div class="page"><h1>Get the Verified badge</h1>
    <p>The ✔ Verified badge is a premium feature. It shows on your profile and all your listings so buyers can trust you.</p>
    ${u.verified ? '<div class="verifybox">✔ You are already verified. Thank you!</div>' : ''}
    <h3>How to get verified</h3>
    <ol><li>Pay the verification fee directly to the LOCAL MARKET admin using the bank details below.</li>
    <li>Upload a clear photo of your ID or passport from your phone gallery below.</li>
    <li>Tap "I have paid". The admin sees your photo and your payment, then approves or rejects.</li></ol>
    <div class="bank"><b>Pay to</b><br>Account name: ${esc(BANK.name)}<br>Bank: ${esc(BANK.bank)}<br>Account number: ${esc(BANK.acct)} <span class="muted">(placeholder: replace with the real account)</span><br>${esc(VERIFY_NOTE)}</div>
    ${u.verified ? '' : pending ? '<p class="pill">Your payment request is waiting for admin approval.</p>' : last && last.status === 'rejected' ? '<p class="muted">Your last request was not approved. Contact LOCAL MARKET support. You can send a new request below.</p>' : ''}
    ${u.verified || pending ? '' : `<form class="cform" onsubmit="return requestVerify(event)">
      <label>Your ID or passport photo (required)<span class="muted">jpg or png from your gallery. Make sure all text is readable.</span><input type="file" accept="image/*" onchange="pickVerifyDoc(this)"></label>
      <div id="docprev"></div>
      <label>Transfer reference (optional)<input name="ref" placeholder="e.g. the bank reference from your transfer"></label>
      <button class="btn big" type="submit">I have paid</button></form>`}
    <p class="muted">Questions? Contact LOCAL MARKET support.</p></div>`;
}
function pageAdmin() {
  const u = me();
  if (!u || !u.isAdmin) return `<div class="page empty">Admin only. <a href="#/login">Log in as admin</a>.</div>`;
  const pend = db.verifyRequests.filter(r => r.status === 'pending');
  return `<div class="page"><h1>Admin panel</h1>
    <div class="stats">
      <div class="stat"><b>${db.users.length}</b><div class="muted">users</div></div>
      <div class="stat"><b>${db.listings.length}</b><div class="muted">listings</div></div>
      <div class="stat"><b>${pend.length}</b><div class="muted">pending verifications</div></div>
    </div>
    <h3>Verification requests (pending)</h3>
    ${pend.map(r => { const p = byId(r.userId) || { name: '?' }; return `<div class="row"><div class="grow"><b>${esc(p.name)}</b> <span class="muted">${esc(p.email || '')} · ${esc(p.phone || '')}</span><br>Reference: ${esc(r.ref) || '(none given)'} · ${when(r.at)}<br>
      ${r.doc ? `<span class="muted">Uploaded ID / passport:</span><br><img class="admindoc" src="${r.doc}" alt="ID document">` : '<span class="pill">No document uploaded (old request). Ask the user for one before approving.</span>'}</div>
      <div><button class="btn small" onclick="setVerified('${r.userId}',true)">Approve</button> <button class="btn small ghost" onclick="rejectRequest('${r.id}')">Reject</button></div></div>`; }).join('') || '<p class="muted">No pending requests.</p>'}
    <h3>Users (${db.users.length})</h3>
    <p class="muted">Warn, suspend or flag any user. Warnings show to the user as a banner. Flags show as a red ⚠ badge on their profile and listings.</p>
    <table class="tbl"><tr><th>Name</th><th>Email</th><th>Phone</th><th>Verified</th><th>Warnings</th><th>Status</th><th>Flag</th><th></th></tr>
    ${db.users.map(x => `<tr><td><a href="#/user/${x.id}">${esc(x.name)}</a>${x.isAdmin ? ' (admin)' : ''}</td><td>${esc(x.email)}</td><td>${esc(x.phone)}</td><td>${x.verified ? 'Yes' : 'No'}</td>
      <td>${(x.warnings || []).length}</td><td>${x.suspended ? '<span class="pill">Suspended</span>' : 'Active'}</td><td>${x.flag ? '<span class="fbadge">⚠ ' + esc(x.flag) + '</span>' : '-'}</td>
      <td>${x.isAdmin ? '' : `<label class="muted">Limit <input id="limit-${x.id}" type="number" min="0" step="1" value="${x.listingLimit != null ? x.listingLimit : ''}" placeholder="unlimited" style="width:90px"></label> <button class="btn small ghost" onclick="setListingLimit('${x.id}')">Set</button> <button class="btn small" onclick="setVerified('${x.id}',${!x.verified})">${x.verified ? 'Remove badge' : 'Mark verified'}</button>
        <button class="btn small ghost" onclick="adminWarn('${x.id}')">Warn</button>
        <button class="btn small ghost" onclick="adminSuspend('${x.id}',${!x.suspended})">${x.suspended ? 'Unsuspend' : 'Suspend'}</button>
        <button class="btn small ghost" onclick="adminFlag('${x.id}')">${x.flag ? 'Change / remove flag' : 'Flag'}</button>
        <button class="btn small" style="background:#b91c1c;color:#fff" onclick="adminDeleteUser('${x.id}')">Delete user</button>`}</td></tr>`).join('')}
    </table>
    <h3>Listings (${db.listings.length})</h3>
    <table class="tbl"><tr><th>Title</th><th>Price</th><th>Seller</th><th></th></tr>
    ${db.listings.map(l => { const s = byId(l.sellerId) || { name: '?' }; return `<tr><td><a href="#/item/${l.id}">${esc(l.title)}</a></td><td>${priceHTML(l, false)}</td><td>${esc(s.name)}</td><td><button class="btn small ghost" onclick="deleteListing('${l.id}')">Delete</button></td></tr>`; }).join('')}
    </table>
    <h3>Admin login</h3>
    <p class="muted">Admin rights come from your profile row (isAdmin). Log in with your own account. Never share your admin login.</p>
    <button class="btn ghost" onclick="resetAll()">Erase all data on this browser</button>
    </div>`;
}

// ===== WARNINGS, SUSPENSION, FLAGS, PROFILE PICTURE =====
function adminDeleteUser(id) {
  const u = me(); if (!u || !u.isAdmin) return false;
  const target = byId(id);
  if (!target || target.isAdmin) { toast('That account cannot be deleted here'); return false; }
  if (!confirm('Delete ' + target.name + '? Their account, listings, comments and messages will be removed. This cannot be undone.')) return false;
  const ids = new Set([id]);
  db.listings.filter(l => l.sellerId === id).forEach(l => ids.add('listing:' + l.id));
  db.users = db.users.filter(x => x.id !== id);
  db.listings = db.listings.filter(l => l.sellerId !== id);
  db.comments = db.comments.filter(c => c.userId !== id && !ids.has('listing:' + c.listingId));
  db.messages = db.messages.filter(m => m.from !== id && m.to !== id);
  db.reactions = db.reactions.filter(r => r.userId !== id && !ids.has('listing:' + r.listingId));
  db.follows = db.follows.filter(f => f.follower !== id && f.following !== id);
  db.verifyRequests = db.verifyRequests.filter(r => r.userId !== id);
  if (db.session === id) db.session = null;
  save(); toast('User deleted'); render();
  return false;
}
let pendingAvatar = '';
window.blockedId = null;
function flagHTML(u) { return u && u.flag ? ' <span class="fbadge">⚠ ' + esc(u.flag) + '</span>' : ''; }
function blockSusp(u) {
  if (!u || !u.suspended) return false;
  toast('Your account is suspended. Reason: ' + (u.suspendReason || 'none given') + '. Contact LOCAL MARKET support to appeal.');
  return true;
}
function warnBanner(u) {
  const w = u.warnings || [];
  if (!w.length || (u.warnAck || 0) >= w.length) return '';
  const last = w[w.length - 1];
  return `<div class="warnbanner"><b>⚠ Warning from the LOCAL MARKET admin:</b> ${esc(last.reason)}<br><span class="muted">${when(last.at)}</span><br><button class="btn small" onclick="ackWarn()">Got it</button></div>`;
}
function ackWarn() { const u = me(); if (!u) return; u.warnAck = (u.warnings || []).length; save(); render(); }
function pageSuspended(u) {
  if (!u) return pageLogin(new URLSearchParams(''));
  return `<div class="page auth"><h2>Your account is suspended</h2>
    <p><b>Reason:</b> ${esc(u.suspendReason || 'No reason given')}</p>
    <p>While suspended you cannot log in, post listings, comment or send messages.</p>
    <p>To appeal, contact LOCAL MARKET support.</p>
    ${me() ? '<button class="btn ghost" onclick="logout()">Log out</button>' : '<button class="btn ghost" onclick="window.blockedId=null;render()">Back to login</button>'}</div>`;
}
function adminWarn(uid) {
  const u = byId(uid); if (!u) return;
  const r = prompt('Warning reason for ' + u.name + ' (they will see it as a banner):');
  if (!r || !r.trim()) return;
  u.warnings = (u.warnings || []).concat([{ reason: r.trim(), at: nowMs() }]);
  save(); toast('Warning sent to ' + u.name); render();
}
function adminSuspend(uid, on) {
  const u = byId(uid); if (!u || u.isAdmin) return;
  if (on) {
    const r = prompt('Reason for suspending ' + u.name + ' (they will see it):');
    if (!r || !r.trim()) return;
    u.suspended = true; u.suspendReason = r.trim();
  } else { u.suspended = false; u.suspendReason = ''; }
  save(); toast(on ? u.name + ' suspended' : u.name + ' unsuspended'); render();
}
function adminFlag(uid) {
  const u = byId(uid); if (!u || u.isAdmin) return;
  const a = prompt('Type "scammer" or "danger" to flag ' + u.name + '. Leave blank to remove the current flag.');
  if (a === null) return;
  const t = a.trim().toLowerCase();
  if (!t) u.flag = '';
  else if (t === 'scammer') u.flag = 'SCAMMER';
  else if (t === 'danger' || t === 'danger sign') u.flag = 'DANGER SIGN';
  else { toast('Type scammer or danger'); return; }
  save(); toast(u.flag ? u.name + ' flagged: ' + u.flag : 'Flag removed'); render();
}
async function pickAvatar(input) {
  const f = input.files[0]; input.value = '';
  if (!f) return;
  try {
    pendingAvatar = await storePhoto(await readImage(f, 400), 'avatars');
    const el = document.getElementById('avprev');
    if (el) el.innerHTML = `<img class="av" src="${pendingAvatar}" alt="">`;
    toast('Picture ready. Tap Save profile.');
  } catch (err) { toast(err.message); }
}

// ===== ROUTER =====
function render() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const q = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '');
  const parts = path.split('/').map(p => decodeURIComponent(p));
  const route = parts[0] || 'home';
  let html;
  const cur = me();
  if (window.blockedId) html = pageSuspended(byId(window.blockedId));
  else if (cur && cur.suspended) html = pageSuspended(cur);
  else if (!cur && (route === 'register' || route === 'login')) html = route === 'register' ? pageRegister() : pageLogin(q);
  else if (!cur) { window.NEXT = path || 'home'; html = pageLogin(new URLSearchParams('next=' + encodeURIComponent(path || 'home'))); } // logged-out: login/register wall only
  else {
    switch (route) {
      case 'home': html = pageHome(q.get('tab')); break;
      case 'cats': html = pageCats(); break;
      case 'cat': html = pageCat(parts[1] || ''); break;
      case 'search': html = pageSearch(q.get('q') || ''); break;
      case 'people': html = pagePeople(q.get('q') || ''); break;
      case 'notifs': html = pageNotifs(); break;
      case 'general': html = pageGeneral(q.get('tab') || 'general'); break;
      case 'item': html = pageItem(parts[1]); break;
      case 'sell': html = pageSell(parts[1]); break;
      case 'login': html = pageLogin(q); break;
      case 'register': html = pageRegister(); break;
      case 'me': html = pageMe(); break;
      case 'requests': html = pageRequests(); break;
      case 'profile': html = pageEditProfile(); break;
      case 'user': html = pageUser(parts[1]); break;
      case 'messages': html = parts[1] ? pageThread(parts[1], q) : pageInbox(); break;
      case 'verify': html = pageVerify(); break;
      case 'admin': html = pageAdmin(); break;
      default: html = `<div class="page empty">Page not found. <a href="#/">Go home</a></div>`;
    }
  }
  document.getElementById('view').innerHTML = (cur && !cur.suspended && !window.blockedId ? warnBanner(cur) : '') + html;
  updateChrome();
  if (route === 'sell') drawPending();
  if (route === 'verify') drawDoc();
}
window.addEventListener('hashchange', () => { if (!/login/.test(location.hash)) window.blockedId = null; window.scrollTo(0, 0); resetPending(); render(); });
render();
