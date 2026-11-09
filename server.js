#!/usr/bin/env node
/*
 * Review Rally – kleiner Team-Server ohne Abhängigkeiten.
 *
 *   node server.js            → http://localhost:3000
 *
 * Umgebungsvariablen:
 *   PORT      (Standard 3000)
 *   HOST      (Standard 0.0.0.0)
 *   DATA_DIR  (Standard ./data) – hier liegt state.json
 *
 * Speichern: Jede Änderung wird sofort nach data/state.json geschrieben, beim Start wird
 * sie wieder geladen. Mehr Backup braucht es nicht.
 *
 * API (JSON):
 *   GET  /api/state?v=<version>  → 204 wenn unverändert, sonst {version, state, owners, meOk}
 *   POST /api/patch  {patch}     → Änderungen feldweise anwenden
 *   POST /api/join   {name, animal} → neues Profil + Schlüssel
 *   POST /api/claim  {id}        → bestehendes, noch freies Profil übernehmen
 *   POST /api/import {state}     → einmaliger Import, nur solange der Server leer ist
 *   GET  /healthz                → "ok"
 *
 * "Login": Jedes Profil hat einen geheimen Schlüssel (nur als Hash gespeichert).
 * Name, Arbeitszeit, Tier und Garderobe eines Profils darf nur ändern, wer den Schlüssel mitschickt
 * (Header X-Member / X-Token). Alles andere (Abwesend, Löschen, PRs, Rennen, XP) ist
 * für das ganze Team bearbeitbar. Das ist Schutz vor Versehen, keine echte Authentifizierung.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'state.json');
const INDEX = path.join(__dirname, 'index.html');
const MAX_BODY = 2 * 1024 * 1024;

const PROTECTED = ['name', 'animal', 'look', 'pct'];   // nur mit eigenem Schlüssel änderbar
const TOP_FIELDS = ['seasonNo', 'seasonStart'];
const COLLECTIONS = ['members', 'prs'];

/* ---------- Speicher: eine state.json, bei jeder Änderung geschrieben, beim Start geladen ---------- */
function emptyDb(){
  return {version: 1, state: {members: [], prs: [], seasonNo: 1, seasonStart: Date.now()}, auth: {}};
}
function loadDb(){
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    d.auth = d.auth || {};
    return d;
  } catch(e){
    if(e.code === 'ENOENT') return emptyDb();   // erster Start
    // Lieber nicht starten als eine kaputte Datei mit leerem Stand zu überschreiben
    console.error(`[rally] ${FILE} ist nicht lesbar – Server startet nicht.`, e.message);
    process.exit(1);
  }
}
let db = loadDb();

function persist(){
  fs.mkdirSync(DATA_DIR, {recursive: true});
  // erst in eine Hilfsdatei schreiben, dann austauschen: so gibt es nie eine halb geschriebene state.json
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
function bump(){ db.version++; persist(); }

/* ---------- Auth ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const newId = () => crypto.randomBytes(6).toString('hex');

function isOwner(req, memberId){
  const id = req.headers['x-member'], tok = req.headers['x-token'];
  const stored = db.auth[memberId];
  if(!stored || id !== memberId || typeof tok !== 'string') return false;
  const a = Buffer.from(sha(tok)), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function meOk(req){
  const id = req.headers['x-member'];
  return !!(id && db.auth[id] && isOwner(req, id) && db.state.members.some(m => m.id === id));
}
function snapshot(req){
  return {version: db.version, state: db.state, owners: Object.keys(db.auth), meOk: meOk(req)};
}

/* ---------- Patch anwenden (gleiche Semantik wie im Browser) ---------- */
function applyPatch(patch, req){
  const st = db.state, rejected = [];
  if(!patch || typeof patch !== 'object') return rejected;
  for(const [k, v] of Object.entries(patch.top || {})) if(TOP_FIELDS.includes(k)) st[k] = v;
  for(const c of COLLECTIONS){
    for(const [id, ch] of Object.entries(patch[c] || {})){
      const i = st[c].findIndex(x => x.id === id);
      if(ch === '__del'){
        if(i >= 0){ st[c].splice(i, 1); if(c === 'members') delete db.auth[id]; }
        continue;
      }
      if(!ch || typeof ch !== 'object') continue;
      if(ch.__new){
        // Neue Profile nur über /api/join, damit jedes Profil einen Schlüssel bekommt
        if(c === 'members'){ rejected.push(id); continue; }
        if(i < 0 && typeof ch.__new === 'object') st[c].push(Object.assign({}, ch.__new, {id}));
        continue;
      }
      if(i < 0) continue;
      const obj = st[c][i];
      for(const [f, v] of Object.entries(ch)){
        if(f === 'id') continue;
        if(c === 'members' && PROTECTED.includes(f) && db.auth[id] && !isOwner(req, id)){ rejected.push(`${id}.${f}`); continue; }
        if(v && typeof v === 'object' && v.__unset) delete obj[f]; else obj[f] = v;
      }
    }
  }
  return rejected;
}

/* ---------- HTTP ---------- */
function send(res, code, body, type = 'application/json; charset=utf-8'){
  const data = body === undefined ? '' : (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(data);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if(size > MAX_BODY){ reject(Object.assign(new Error('Anfrage zu groß'), {code: 413})); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch(e){ reject(Object.assign(new Error('Ungültiges JSON'), {code: 400})); } });
    req.on('error', reject);
  });
}
const cleanName = n => String(n || '').trim().slice(0, 40);

const routes = {
  'GET /': (req, res) => {
    fs.readFile(INDEX, (err, html) => err ? send(res, 500, 'index.html fehlt', 'text/plain; charset=utf-8') : send(res, 200, html, 'text/html; charset=utf-8'));
  },
  'GET /healthz': (req, res) => send(res, 200, 'ok', 'text/plain; charset=utf-8'),
  'GET /api/state': (req, res, url) => {
    const v = Number(url.searchParams.get('v'));
    if(v && v === db.version) return send(res, 204);
    send(res, 200, snapshot(req));
  },
  'POST /api/patch': async (req, res) => {
    const body = await readBody(req);
    const rejected = applyPatch(body.patch, req);
    bump();
    send(res, 200, Object.assign(snapshot(req), {rejected}));
  },
  'POST /api/join': async (req, res) => {
    const body = await readBody(req), name = cleanName(body.name);
    if(!name) return send(res, 400, {error: 'Name fehlt'});
    if(db.state.members.some(m => m.name.toLowerCase() === name.toLowerCase())) return send(res, 409, {error: 'Den Namen gibt es schon. Falls das du bist: Profil übernehmen.'});
    const id = newId(), token = newToken();
    db.state.members.push({id, name, animal: String(body.animal || 'capybara'), pct: 100, away: false,
      seasonXp: 0, totalXp: 0, seasonReviews: 0, totalReviews: 0, jokers: 1, kudos: 0, history: []});
    db.auth[id] = sha(token);
    bump();
    req.headers['x-member'] = id; req.headers['x-token'] = token;
    send(res, 200, Object.assign(snapshot(req), {id, token}));
  },
  'POST /api/claim': async (req, res) => {
    const body = await readBody(req), id = String(body.id || '');
    if(!db.state.members.some(m => m.id === id)) return send(res, 404, {error: 'Profil nicht gefunden'});
    if(db.auth[id]) return send(res, 409, {error: 'Dieses Profil gehört schon jemandem.'});
    const token = newToken(); db.auth[id] = sha(token);
    bump();
    req.headers['x-member'] = id; req.headers['x-token'] = token;
    send(res, 200, Object.assign(snapshot(req), {id, token}));
  },
  'POST /api/import': async (req, res) => {
    const body = await readBody(req), s = body.state;
    if(db.state.members.length || db.state.prs.length) return send(res, 409, {error: 'Import geht nur, solange der Server leer ist.'});
    if(!s || !Array.isArray(s.members) || !Array.isArray(s.prs)) return send(res, 400, {error: 'Ungültige Daten'});
    db.state = {members: s.members, prs: s.prs, seasonNo: s.seasonNo || 1, seasonStart: s.seasonStart || Date.now()};
    db.auth = {};
    bump();
    send(res, 200, snapshot(req));
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`] || (req.method === 'GET' && url.pathname === '/index.html' ? routes['GET /'] : null);
  if(!route) return send(res, 404, {error: 'Nicht gefunden'});
  try { await route(req, res, url); }
  catch(e){ console.error('[rally]', req.method, url.pathname, e.message); if(!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, {error: e.message}); }
});

// Ohne gesetztes PORT (lokal) werden bei Bedarf Ausweich-Ports probiert.
// Mit gesetztem PORT (z. B. im Cluster) gibt es bewusst keinen Ausweich-Port.
const candidates = process.env.PORT ? [PORT] : [PORT, 3001, 5000, 8888, 9090];
let attempt = 0;
server.on('error', e => {
  const port = candidates[attempt];
  if(e.code === 'EACCES' || e.code === 'EADDRINUSE'){
    const why = e.code === 'EADDRINUSE' ? 'schon belegt' : 'vom System gesperrt, unter Windows oft durch Hyper-V/WSL/Docker reserviert';
    if(attempt + 1 < candidates.length){
      console.log(`[rally] Port ${port} ist ${why}, versuche ${candidates[attempt + 1]} …`);
      attempt++; return listen();
    }
    console.error(`[rally] Port ${port} ist nicht verfügbar (${why}).`);
    console.error(`[rally] Anderen Port wählen, z. B.:  PowerShell: $env:PORT=4000; node server.js   ·   Bash: PORT=4000 node server.js`);
  } else console.error('[rally] Server-Fehler:', e.message);
  process.exit(1);
});
server.once('listening', () => console.log(`[rally] läuft auf http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${server.address().port}  (Daten: ${FILE})`));
function listen(){ server.listen(candidates[attempt], HOST); }
listen();
for(const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log('[rally] fahre herunter'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
