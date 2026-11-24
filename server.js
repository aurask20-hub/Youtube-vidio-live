'use strict';
/*
  লাইভ স্টুডিও সার্ভার v2
  ------------------------------------------------------------
  চালানো:   node server.js
  পাসওয়ার্ডসহ:  PASSWORD=আপনার_পাসওয়ার্ড node server.js
  অন্য ডিভাইস থেকে খুলতে: HOST=0.0.0.0 PASSWORD=xxxx node server.js

  এনভায়রনমেন্ট ভ্যারিয়েবল (সবকটি ঐচ্ছিক):
    PORT=3000  HOST=127.0.0.1  PASSWORD=...  MAX_UPLOAD_GB=4
    YT_STREAM_KEY=...  FFMPEG=ffmpeg  FFPROBE=ffprobe

  পুরনো index.html এর সঙ্গে সম্পূর্ণ সামঞ্জস্যপূর্ণ।
  নতুন সুবিধা: প্লেলিস্ট, অটো-রিকানেক্ট, স্টল ডিটেকশন, শিডিউল, টাইমার,
  একাধিক গন্তব্য, কপি মোড (কম CPU), লগইন, থাম্বনেইল, লাইভ স্ট্যাটস, হিস্টরি।
*/

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- কনফিগ
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.PASSWORD || '';
const MAX_UPLOAD_GB = parseFloat(process.env.MAX_UPLOAD_GB) || 4;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const BOT_TOKEN = process.env.BOT_TOKEN || '';                       // BotFather থেকে পাওয়া টোকেন
const ADMIN_IDS = new Set(String(process.env.ADMIN_IDS || '').split(/[\s,]+/).filter(Boolean)); // অ্যাডমিনের টেলিগ্রাম আইডি

const ROOT = __dirname;
const STORE = process.env.STORAGE_DIR || ROOT;   // Render-এ ডিস্কের পাথ (যেমন /var/data)
const UPLOAD_DIR = path.join(STORE, 'uploads');
const THUMB_DIR = path.join(STORE, 'thumbs');
const DATA_DIR = path.join(STORE, 'data');
[UPLOAD_DIR, THUMB_DIR, DATA_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const STALL_MS = 45000;     // এতক্ষণ কোনো অগ্রগতি না থাকলে স্ট্রিম রিস্টার্ট হবে
const MAX_FAILS = 50;       // টানা এতবার ব্যর্থ হলে হাল ছাড়বে
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts', '.3gp', '.wmv']);
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];
const QUALITY = {
  '360':  { w: 640,  h: 360,  vb: 800 },
  '480':  { w: 854,  h: 480,  vb: 1500 },
  '720':  { w: 1280, h: 720,  vb: 3000 },
  '1080': { w: 1920, h: 1080, vb: 6000 },
};
const PLATFORMS = {
  youtube:  'rtmp://a.rtmp.youtube.com/live2',
  facebook: 'rtmps://live-api-s.facebook.com:443/rtmp',
  twitch:   'rtmp://live.twitch.tv/app',
};

// ---------------------------------------------------------------- ছোট সহায়ক
const now = () => Date.now();
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const pad = n => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const label = n => String(n).replace(/^\d+-/, '');
const httpErr = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJSON = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 1)); } catch {} };

// ---- ইউজার, ফাইলের মালিক, সেটিংস, অ্যাক্সেস অনুরোধ
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const OWN_FILE = path.join(DATA_DIR, 'owners.json');
const SET_FILE = path.join(DATA_DIR, 'settings.json');
const REQ_FILE = path.join(DATA_DIR, 'requests.json');
const USERS = loadJSON(USERS_FILE, {});      // id -> {name, username, active, quotaGB, canStream, maxStreamMinutes, note, added, lastSeen, streamSeconds}
const OWN = loadJSON(OWN_FILE, {});          // ফাইলের নাম -> মালিকের আইডি
const REQS = loadJSON(REQ_FILE, {});         // অনুমতি চেয়েছে যারা
const SETTINGS = Object.assign({ defaultQuotaGB: 5, maintenance: false, support: '', names: {} }, loadJSON(SET_FILE, {}));
SETTINGS.names = SETTINGS.names || {};
const persist = () => { saveJSON(USERS_FILE, USERS); saveJSON(OWN_FILE, OWN); saveJSON(SET_FILE, SETTINGS); saveJSON(REQ_FILE, REQS); };
const GB = 1024 ** 3;
const isAdminId = id => ADMIN_IDS.has(String(id));
const nameOf = id => (USERS[id] && USERS[id].name) || SETTINGS.names[id] || String(id);
const canSee = (u, n) => u.admin || String(OWN[n]) === String(u.id);
const quotaBytes = u => { const g = u && u.quotaGB != null ? u.quotaGB : SETTINGS.defaultQuotaGB; return g > 0 ? g * GB : 0; }; // 0 = সীমাহীন
function usage() {
  const m = {};
  for (const f of listFiles()) {
    const o = OWN[f] ? String(OWN[f]) : '?';
    try { const z = fs.statSync(path.join(UPLOAD_DIR, f)).size; (m[o] = m[o] || { bytes: 0, files: 0 }); m[o].bytes += z; m[o].files++; } catch {}
  }
  return m;
}
const userBytes = id => (usage()[String(id)] || { bytes: 0 }).bytes;
function tgSend(chat, text) {
  if (!BOT_TOKEN || typeof fetch !== 'function') return;
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }).catch(() => {});
}

// লগ (স্ট্রিম কী সবসময় ঢেকে দেওয়া হয়)
const LOGS = [];
const secrets = new Set();
function mask(s) {
  let out = String(s);
  for (const k of secrets) if (k) out = out.split(k).join('••••');
  return out.replace(/(rtmps?:\/\/[^\s\/]+\/[^\s\/]+\/)[^\s"'|\]]+/g, '$1••••');
}
function log(msg) {
  const line = `[${stamp()}] ${mask(msg)}`;
  LOGS.push(line);
  if (LOGS.length > 300) LOGS.shift();
  console.log(line);
}

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    const p = spawn(cmd, args);
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('timeout')); }, timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || ('exit ' + code)));
    });
  });
}

// ---------------------------------------------------------------- ফাইল ও মেটাডাটা
const META = new Map();

function safeName(n) {
  const b = path.basename(String(n || ''));
  if (!b || b.startsWith('.')) return null;
  const f = path.join(UPLOAD_DIR, b);
  try { return fs.statSync(f).isFile() ? b : null; } catch { return null; }
}

function listFiles() {
  return fs.readdirSync(UPLOAD_DIR)
    .filter(f => !f.startsWith('.'))
    .map(f => { try { const st = fs.statSync(path.join(UPLOAD_DIR, f)); return st.isFile() ? { f, m: st.mtimeMs } : null; } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.m - b.m)
    .map(x => x.f);
}

async function probe(name) {
  const file = path.join(UPLOAD_DIR, name);
  const st = fs.statSync(file);
  const c = META.get(name);
  if (c && c.mtime === st.mtimeMs) return c.meta;
  const meta = { name, label: label(name), size: st.size, uploadedAt: st.mtimeMs, ok: false };
  try {
    const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
    const streams = j.streams || [];
    const v = streams.find(s => s.codec_type === 'video');
    const a = streams.find(s => s.codec_type === 'audio');
    if (v) {
      const [n, d] = String(v.r_frame_rate || '0/1').split('/').map(Number);
      meta.ok = true;
      meta.width = v.width; meta.height = v.height;
      meta.vcodec = v.codec_name; meta.pix = v.pix_fmt;
      meta.fps = d ? Math.round(n / d * 100) / 100 : 0;
      meta.acodec = a ? a.codec_name : null;
      meta.hasAudio = !!a;
      meta.duration = parseFloat((j.format || {}).duration) || 0;
      meta.copyOk = !!(v.codec_name === 'h264' && v.pix_fmt === 'yuv420p' && a && a.codec_name === 'aac' && v.height <= 1080 && meta.fps <= 60);
    }
  } catch (e) {
    meta.probeError = e.message;
    if (e.code === 'ENOENT') { meta.ok = true; meta.hasAudio = true; meta.duration = 0; meta.copyOk = false; } // ffprobe নেই
  }
  META.set(name, { mtime: st.mtimeMs, meta });
  return meta;
}

const thumbJobs = new Map();
async function makeThumb(name) {
  const out = path.join(THUMB_DIR, name + '.jpg');
  if (fs.existsSync(out)) return out;
  if (thumbJobs.has(name)) return thumbJobs.get(name);
  const job = (async () => {
    const src = path.join(UPLOAD_DIR, name);
    for (const ss of ['1', '0']) {
      try {
        await run(FFMPEG, ['-y', '-v', 'error', '-ss', ss, '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', out], 20000);
        if (fs.existsSync(out)) return out;
      } catch {}
    }
    throw new Error('thumb failed');
  })().finally(() => thumbJobs.delete(name));
  thumbJobs.set(name, job);
  return job;
}

// ---------------------------------------------------------------- লাইভের অবস্থা
const S = {
  state: 'idle',            // idle | scheduled | live | reconnecting
  proc: null, opts: null, files: [],
  sessionStart: null, procStart: 0, scheduledFor: null,
  restarts: 0, failStreak: 0, userStop: false,
  stats: {}, pending: {}, lastProgress: 0, lastError: '',
  copy: false, lowCount: 0, lastLowWarn: 0, hints: new Set(), lastLine: '',
  timers: {},
};
let starting = false;

const HIST_FILE = path.join(DATA_DIR, 'history.json');
const LAST_FILE = path.join(DATA_DIR, 'last.json');

function recordHistory(reason) {
  const h = loadJSON(HIST_FILE, []);
  h.push({
    start: S.sessionStart, end: now(),
    seconds: Math.round((now() - S.sessionStart) / 1000),
    restarts: S.restarts, reason,
    files: S.files.map(label),
    targets: S.opts ? S.opts.targets.map(t => t.platform) : [],
    owner: S.opts ? S.opts.owner : null, ownerName: S.opts ? S.opts.ownerName : '',
  });
  saveJSON(HIST_FILE, h.slice(-300));
  const ou = S.opts && USERS[S.opts.owner];
  if (ou) { ou.streamSeconds = (ou.streamSeconds || 0) + Math.round((now() - S.sessionStart) / 1000); persist(); }
}

function saveLast(o) {
  saveJSON(LAST_FILE, {
    files: o.files, loop: o.loop, quality: o.quality, fps: o.fps, bitrate: o.bitrate,
    preset: o.preset, mode: o.mode, autoRestart: o.autoRestart,
    durationMinutes: o.durationMinutes, platforms: o.targets.map(t => t.platform),
  });
}

// ---------------------------------------------------------------- গন্তব্য (YouTube/Facebook/Twitch/কাস্টম)
function buildTargets(b) {
  const list = [];
  if (Array.isArray(b.targets) && b.targets.length) {
    if (b.targets.length > 5) throw new Error('সর্বোচ্চ ৫টি গন্তব্য দেওয়া যাবে');
    for (const t of b.targets) {
      const p = String(t.platform || 'youtube');
      const k = String(t.key || '').trim();
      const base = p === 'custom' ? String(t.url || '').trim().replace(/\/+$/, '') : PLATFORMS[p];
      if (!base) throw new Error('অজানা প্ল্যাটফর্ম: ' + p);
      if (!/^rtmps?:\/\/[\w.\-:\/]+$/.test(base)) throw new Error('RTMP URL ঠিক নয়');
      if (!/^[\w\-?=&.]{4,250}$/.test(k)) throw new Error(`${p} এর স্ট্রিম কী ঠিক নয়`);
      list.push({ platform: p, key: k, url: base + '/' + k });
    }
  } else {
    const key = String(b.key || process.env.YT_STREAM_KEY || '').trim();
    if (!/^[\w\-]{8,64}$/.test(key)) throw new Error('স্ট্রিম কী ঠিক নয়');
    list.push({ platform: 'youtube', key, url: PLATFORMS.youtube + '/' + key });
  }
  return list;
}

// ---------------------------------------------------------------- FFmpeg আর্গুমেন্ট
function writeConcat(file, o) {
  const esc = p => p.replace(/'/g, "'\\''");
  const total = o.metas.reduce((a, m) => a + (m.duration || 60), 0);
  let reps = 1;
  if (o.loop) {
    reps = Math.ceil(12 * 3600 / Math.max(total, 1));
    reps = clamp(reps, 1, Math.max(1, Math.floor(5000 / o.files.length)));
  }
  const lines = ['ffconcat version 1.0'];
  for (let r = 0; r < reps; r++) for (const n of o.files) lines.push(`file '${esc(path.join(UPLOAD_DIR, n))}'`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function buildArgs(o) {
  const notes = [];
  const q = QUALITY[o.quality] || QUALITY['720'];
  const fps = [24, 25, 30, 50, 60].includes(o.fps) ? o.fps : 30;
  const vb = clamp(parseInt(o.bitrate, 10) || q.vb, 500, 15000);
  const preset = PRESETS.includes(o.preset) ? o.preset : 'veryfast';
  const single = o.files.length === 1;
  const noAudioAny = o.metas.some(m => m.hasAudio === false);
  const noAudioAll = o.metas.every(m => m.hasAudio === false);

  let copy = false;
  if (o.mode === 'copy') {
    if (single && o.metas[0].copyOk) {
      copy = true;
      notes.push('কপি মোড: ভিডিও আবার এনকোড হচ্ছে না (CPU কম লাগবে)। কীফ্রেম ৪ সেকেন্ডের বেশি হলে ইউটিউব সতর্কতা দিতে পারে।');
    } else {
      notes.push('কপি মোড এই ভিডিওতে চলবে না (H.264 + AAC + yuv420p এবং একটিমাত্র ভিডিও লাগে), তাই সাধারণ এনকোড মোডে চলছে।');
    }
  }
  if (noAudioAny && !noAudioAll) notes.push('সতর্কতা: কিছু ভিডিওতে অডিও নেই, তাই পুরো লাইভ নিঃশব্দ থাকবে।');
  if (noAudioAny && noAudioAll) notes.push('ভিডিওতে অডিও নেই, তাই নিঃশব্দ অডিও যোগ হচ্ছে।');

  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-progress', 'pipe:1', '-re'];
  if (copy) args.push('-fflags', '+genpts');
  if (single) {
    if (o.loop) args.push('-stream_loop', '-1');
    args.push('-i', path.join(UPLOAD_DIR, o.files[0]));
  } else {
    args.push('-f', 'concat', '-safe', '0', '-i', o.listFile);
  }
  if (noAudioAny) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  args.push('-map', '0:v:0', '-map', noAudioAny ? '1:a:0' : '0:a:0');

  if (copy) {
    args.push('-c:v', 'copy', '-c:a', 'copy');
  } else {
    args.push(
      '-vf', `scale=${q.w}:${q.h}:force_original_aspect_ratio=decrease,pad=${q.w}:${q.h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', preset,
      '-b:v', vb + 'k', '-maxrate', vb + 'k', '-bufsize', (vb * 2) + 'k',
      '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'
    );
    if (!noAudioAny) args.push('-af', 'aresample=async=1:first_pts=0');
  }
  if (noAudioAny) args.push('-shortest');

  if (o.targets.length === 1) {
    args.push('-flvflags', 'no_duration_filesize', '-f', 'flv', o.targets[0].url);
  } else {
    args.push('-f', 'tee', o.targets.map(t => `[f=flv:onfail=ignore]${t.url}`).join('|'));
  }
  return { args, notes, copy };
}

// ---------------------------------------------------------------- স্ট্রিম চালানো
const HINTS = [
  [/Connection refused|Network is unreachable|timed out|Name or service not known|Could not resolve/i, 'ইন্টারনেট সংযোগ বা সার্ভার ঠিকানা পরীক্ষা করুন।'],
  [/Broken pipe|Connection reset|Input\/output error|Error writing trailer|av_interleaved_write_frame/i, 'ইউটিউবের সঙ্গে সংযোগ কেটে গেছে। ইন্টারনেট বা স্ট্রিম কী পরীক্ষা করুন।'],
  [/Server returned 40[13]|handshake failed|Operation not permitted/i, 'স্ট্রিম কী ভুল বা মেয়াদোত্তীর্ণ হতে পারে। YouTube Studio থেকে নতুন করে কপি করুন।'],
  [/No such file/i, 'ভিডিও ফাইল পাওয়া যায়নি।'],
  [/Unknown encoder|Unrecognized option|Encoder .* not found/i, 'এই FFmpeg-এ প্রয়োজনীয় ফিচার নেই। pkg upgrade ffmpeg চালিয়ে দেখুন।'],
];

function onProgress(m) {
  S.lastProgress = now();
  const us = parseInt(m.out_time_us || m.out_time_ms, 10);
  S.stats = {
    frame: +m.frame || 0,
    fps: +m.fps || 0,
    bitrate: m.bitrate || '',
    speed: parseFloat(m.speed) || 0,
    dropped: +m.drop_frames || 0,
    size: +m.total_size || 0,
    outSec: isNaN(us) ? 0 : Math.round(us / 1e6),
  };
  if (S.failStreak && S.stats.outSec >= 60) S.failStreak = 0;
  // ধীর এনকোডিং শনাক্ত
  if (!S.copy && S.stats.speed && S.stats.speed < 0.9 && S.stats.outSec > 10) {
    S.lowCount++;
    if (S.lowCount >= 6 && now() - S.lastLowWarn > 60000) {
      S.lastLowWarn = now();
      log(`সতর্কতা: এনকোডিং ধীর (${S.stats.speed}x)। কোয়ালিটি কমান, preset ultrafast দিন, অথবা কপি মোড ব্যবহার করুন।`);
    }
  } else {
    S.lowCount = 0;
  }
}

function spawnFF() {
  const o = S.opts;
  let listFile = null;
  if (o.files.length > 1) {
    listFile = path.join(DATA_DIR, 'playlist.txt');
    writeConcat(listFile, o);
  }
  const { args, notes, copy } = buildArgs({ ...o, listFile });
  notes.forEach(n => log(n));

  S.state = 'live';
  S.copy = copy;
  S.procStart = now();
  S.lastProgress = now();
  S.stats = {};
  S.pending = {};
  S.lowCount = 0;
  S.hints = new Set();
  S.lastLine = '';

  let p;
  try {
    p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log('FFmpeg চালু করা যায়নি: ' + e.message);
    return finish('error');
  }
  S.proc = p;

  let buf = '';
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq), v = line.slice(eq + 1);
      S.pending[k] = v;
      if (k === 'progress') { onProgress(S.pending); S.pending = {}; }
    }
  });

  p.stderr.on('data', d => {
    String(d).split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(l => {
      if (l === S.lastLine) return;
      S.lastLine = l; S.lastError = mask(l);
      log('ffmpeg: ' + l);
      for (const [re, msg] of HINTS) {
        if (re.test(l) && !S.hints.has(msg)) { S.hints.add(msg); log('পরামর্শ: ' + msg); }
      }
    });
  });

  p.on('error', e => {
    if (S.proc !== p) return;
    S.proc = null;
    log(e.code === 'ENOENT' ? 'FFmpeg পাওয়া যায়নি। চালান: pkg install ffmpeg' : 'FFmpeg ত্রুটি: ' + e.message);
    finish('error');
  });

  p.on('close', (code, sig) => {
    if (S.proc !== p) return;
    S.proc = null;
    onExit(code, sig);
  });
}

function setRestart(ms) {
  clearTimeout(S.timers.restart);
  S.timers.restart = setTimeout(() => {
    if (S.state === 'reconnecting' && !S.userStop) spawnFF();
  }, ms);
}

function onExit(code, sig) {
  const ran = now() - S.procStart;
  const o = S.opts;
  if (S.userStop) return finish('user');
  if (code === 0 && !o.loop) { log('সব ভিডিও চালানো শেষ হয়েছে'); return finish('done'); }
  if (code === 0 && o.loop && ran >= 3000) {
    log('প্লেলিস্ট শেষ, আবার শুরু হচ্ছে');
    S.state = 'reconnecting';
    return setRestart(1000);
  }
  log(`FFmpeg থেমে গেছে (code ${code}${sig ? ', ' + sig : ''}), ${Math.round(ran / 1000)} সেকেন্ড চলেছিল`);
  if (!o.autoRestart) return finish('crash');
  if (ran > 60000) S.failStreak = 0;
  S.failStreak++; S.restarts++;
  if (S.failStreak > MAX_FAILS) { log('বারবার ব্যর্থ হয়েছে, আর চেষ্টা করা হচ্ছে না'); return finish('failed'); }
  const delay = Math.min(30000, 2000 * 2 ** (S.failStreak - 1));
  log(`${delay / 1000} সেকেন্ড পর আবার চেষ্টা হবে (${S.failStreak}/${MAX_FAILS})`);
  S.state = 'reconnecting';
  setRestart(delay);
}

function finish(reason) {
  Object.values(S.timers).forEach(clearTimeout);
  S.timers = {};
  if (S.sessionStart) recordHistory(reason);
  if (reason === 'user') log('লাইভ বন্ধ করা হয়েছে');
  S.state = 'idle';
  S.proc = null;
  S.scheduledFor = null;
  S.sessionStart = null;
  S.userStop = false;
  secrets.clear();
}

function stopStream(reason = 'user') {
  if (S.state === 'idle') return false;
  Object.entries(S.timers).forEach(([k, t]) => { if (k !== 'kill') clearTimeout(t); });
  S.userStop = true;
  if (S.proc) {
    try { S.proc.kill('SIGINT'); } catch {}
    S.timers.kill = setTimeout(() => { if (S.proc) { try { S.proc.kill('SIGKILL'); } catch {} } }, 5000);
  } else {
    finish(reason);
  }
  return true;
}

function launch(opts) {
  S.opts = opts;
  S.files = opts.files;
  S.userStop = false;
  S.restarts = 0;
  S.failStreak = 0;
  S.sessionStart = now();
  S.scheduledFor = null;
  S.lastError = '';
  clearTimeout(S.timers.start);
  if (opts.durationMinutes) {
    S.timers.stop = setTimeout(() => { log('নির্ধারিত সময় শেষ, লাইভ বন্ধ হচ্ছে'); stopStream('timer'); }, opts.durationMinutes * 60000);
  }
  saveLast(opts);
  log(`লাইভ শুরু: ${opts.files.length}টি ভিডিও, ${opts.quality}p${opts.loop ? ', লুপ' : ''}, গন্তব্য: ${opts.targets.map(t => t.platform).join(' + ')}`);
  spawnFF();
}

async function startStream(b, user) {
  if (starting) throw httpErr(400, 'একটু অপেক্ষা করুন');
  if (S.state !== 'idle') throw httpErr(400, 'আগের লাইভ চলছে বা শিডিউল করা আছে, আগে বন্ধ করুন');
  starting = true;
  try {
    let names = Array.isArray(b.files) && b.files.length ? b.files : [b.file];
    if (names.length > 100) throw httpErr(400, 'প্লেলিস্টে সর্বোচ্চ ১০০টি ভিডিও');
    names = names.map(safeName);
    if (!names.length || names.some(n => !n)) throw httpErr(400, 'ভিডিও ফাইল নেই');
    if (names.some(n => !canSee(user, n))) throw httpErr(403, 'এই ভিডিও আপনার নয়');
    if (b.shuffle) for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }

    let targets;
    try { targets = buildTargets(b); } catch (e) { throw httpErr(400, e.message); }

    const metas = [];
    for (const n of names) {
      const m = await probe(n);
      if (!m.ok) throw httpErr(400, 'এটি ভিডিও ফাইল নয়: ' + label(n));
      metas.push(m);
    }

    const opts = {
      files: names, metas, targets,
      loop: !!b.loop,
      quality: QUALITY[String(b.quality)] ? String(b.quality) : '720',
      fps: parseInt(b.fps, 10) || 30,
      bitrate: parseInt(b.bitrate, 10) || 0,
      preset: b.preset,
      mode: b.mode === 'copy' ? 'copy' : 'encode',
      autoRestart: b.autoRestart !== false,
      durationMinutes: clamp(parseFloat(b.durationMinutes) || 0, 0, 60 * 24 * 14),
    };
    opts.owner = String(user.id); opts.ownerName = user.name || '';
    if (!user.admin) {
      if (user.canStream === false) throw httpErr(403, 'আপনাকে লাইভ করার অনুমতি দেওয়া হয়নি');
      const mx = user.maxStreamMinutes || 0;
      if (mx && (!opts.durationMinutes || opts.durationMinutes > mx)) opts.durationMinutes = mx;
    }

    secrets.clear();
    targets.forEach(t => secrets.add(t.key));

    // শিডিউল
    let at = 0;
    if (b.startAt) at = typeof b.startAt === 'number' ? b.startAt : Date.parse(b.startAt);
    else if (b.delayMinutes) at = now() + parseFloat(b.delayMinutes) * 60000;
    if (at && isNaN(at)) throw httpErr(400, 'শুরুর সময় ঠিক নয়');
    if (at > now() + 2000) {
      if (at > now() + 14 * 864e5) throw httpErr(400, 'সর্বোচ্চ ১৪ দিন আগে শিডিউল করা যাবে');
      S.opts = opts; S.files = names; S.state = 'scheduled'; S.scheduledFor = at; S.userStop = false;
      S.timers.start = setTimeout(() => launch(opts), at - now());
      log(`লাইভ শিডিউল করা হয়েছে: ${new Date(at).toLocaleString()}`);
      return { scheduled: true, at };
    }
    launch(opts);
    return { scheduled: false };
  } finally {
    starting = false;
  }
}

// স্টল ওয়াচডগ
setInterval(() => {
  if (S.state === 'live' && S.proc && now() - S.lastProgress > STALL_MS) {
    log(`${STALL_MS / 1000} সেকেন্ড কোনো অগ্রগতি নেই, স্ট্রিম রিস্টার্ট হচ্ছে`);
    S.lastProgress = now();
    try { S.proc.kill('SIGKILL'); } catch {}
  }
}, 5000);

// ---------------------------------------------------------------- স্ট্যাটাস
function nowPlaying() {
  const o = S.opts;
  if (!o || (S.state !== 'live' && S.state !== 'reconnecting')) return null;
  const durs = o.metas.map(m => m.duration || 0);
  const total = durs.reduce((a, b) => a + b, 0);
  if (!total) return { name: o.files[0], label: label(o.files[0]), index: 1, count: o.files.length };
  let pos = (S.stats.outSec || 0) % total, i = 0;
  while (i < durs.length - 1 && pos >= durs[i]) { pos -= durs[i]; i++; }
  return { name: o.files[i], label: label(o.files[i]), index: i + 1, count: o.files.length, pos: Math.round(pos), duration: Math.round(durs[i]) };
}

function statusObj(user) {
  // অন্যের লাইভ হলে ওভারভিউ দেখা যাবে, কিন্তু লগ/গন্তব্য/ফাইলের তালিকা লুকানো থাকবে
  const other = !!(user && !user.admin && S.state !== 'idle' && S.opts && String(S.opts.owner) !== String(user.id));
  const live = S.state === 'live' || S.state === 'reconnecting';
  const sp = S.stats.speed || 0;
  return {
    live,                                   // পুরনো UI-র জন্য
    state: S.state,
    file: live ? S.files[0] : null,         // পুরনো UI-র জন্য
    files: other ? [] : S.files,
    log: other ? [] : LOGS.slice(-3),                    // পুরনো UI-র জন্য
    nowPlaying: nowPlaying(),
    uptime: live && S.sessionStart ? Math.round((now() - S.sessionStart) / 1000) : 0,
    restarts: S.restarts,
    scheduledFor: S.scheduledFor,
    stats: S.stats,
    health: !live ? null : (S.state === 'reconnecting' ? 'bad' : (!sp ? 'starting' : sp >= 0.95 ? 'good' : sp >= 0.8 ? 'weak' : 'bad')),
    mode: S.copy ? 'copy' : 'encode',
    targets: !other && S.opts ? S.opts.targets.map(t => t.platform) : [],
    lastError: other ? '' : S.lastError,
    ownerName: S.opts ? S.opts.ownerName : '',
    busy: other, busyBy: other ? (S.opts.ownerName || '') : '',
  };
}

// ---------------------------------------------------------------- অ্যাপ ও লগইন
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const sessions = new Map();
const attempts = new Map();
function parseCookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch {} }
  });
  return o;
}
function authed(req) {
  if (!PASSWORD) return true;
  const t = parseCookies(req).sid;
  const e = t && sessions.get(t);
  if (e && e > now()) return true;
  if (t) sessions.delete(t);
  return false;
}
function safeEq(a, b) {
  const h = x => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

const loginPage = e => `<!DOCTYPE html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>লগইন</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c0e1d;color:#eef0ff;font-family:system-ui,sans-serif}form{width:min(92vw,340px);background:#151833;border:1px solid #2b3060;border-radius:18px;padding:24px}h1{font-size:1.3rem;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:12px;border:1px solid #2b3060;margin-top:10px}input{background:#1c2040;color:#eef0ff}button{background:linear-gradient(135deg,#ff3b5c,#7c5cff);border:0;color:#fff;font-weight:700;cursor:pointer}p{color:#ff8a9b;margin:10px 0 0}</style></head><body><form method="post" action="/login"><h1>লাইভ স্টুডিও</h1><input type="password" name="password" placeholder="পাসওয়ার্ড" autofocus required>${e === '1' ? '<p>পাসওয়ার্ড ভুল। আবার চেষ্টা করুন।</p>' : ''}${e === '2' ? '<p>অনেকবার ভুল হয়েছে। ১০ মিনিট পরে চেষ্টা করুন।</p>' : ''}<button>লগইন</button></form></body></html>`;

app.get('/health', (req, res) => res.json({ ok: true, pw: !!PASSWORD, support: SETTINGS.support || '' }));

app.get('/login', (req, res) => {
  if (!PASSWORD || authed(req)) return res.redirect('/');
  res.type('html').send(loginPage(String(req.query.e || '')));
});

app.post('/login', (req, res) => {
  const json = !!req.is('application/json');
  const ip = req.ip || 'x';
  const rec = attempts.get(ip) || { n: 0, t: now() };
  if (now() - rec.t > 600000) { rec.n = 0; rec.t = now(); }
  if (rec.n >= 5) return json ? res.status(429).json({ error: 'অনেকবার ভুল, ১০ মিনিট পরে চেষ্টা করুন' }) : res.redirect('/login?e=2');
  const pw = (req.body || {}).password;
  if (PASSWORD && pw && safeEq(pw, PASSWORD)) {
    attempts.delete(ip);
    const t = crypto.randomBytes(24).toString('hex');
    sessions.set(t, now() + 7 * 864e5);
    res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`);
    log('লগইন সফল');
    return json ? res.json({ ok: true }) : res.redirect('/');
  }
  rec.n++; attempts.set(ip, rec);
  log('ভুল পাসওয়ার্ড দিয়ে লগইনের চেষ্টা');
  return json ? res.status(401).json({ error: 'পাসওয়ার্ড ভুল' }) : res.redirect('/login?e=1');
});

app.post('/logout', (req, res) => {
  const t = parseCookies(req).sid;
  if (t) sessions.delete(t);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---- টেলিগ্রাম মিনি অ্যাপ যাচাই
const tokens = new Map();
const openMode = !PASSWORD && !BOT_TOKEN;   // কোনো সুরক্ষা সেট না থাকলে আগের মতোই খোলা (শুধু লোকাল টেস্টের জন্য)
function verifyInit(init) {
  if (!BOT_TOKEN) return null;
  const p = new URLSearchParams(init);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (now() / 1000 - (+p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
function currentUser(req) {
  if (openMode) return { id: 'local', name: 'Local', admin: true };
  const t = req.headers['x-token'] || req.query.t;
  const e = t && tokens.get(String(t));
  if (e && e.exp > now()) {
    if (isAdminId(e.id)) return { id: String(e.id), name: e.name, admin: true };
    const u = USERS[e.id];
    return u && u.active !== false ? { ...u, id: String(e.id), admin: false } : null;
  }
  if (PASSWORD) { const c = parseCookies(req).sid; const x = c && sessions.get(c); if (x && x > now()) return { id: 'pw', name: 'Admin', admin: true }; }
  return null;
}
app.post('/auth/tg', (req, res) => {
  const u = verifyInit(String((req.body || {}).initData || ''));
  if (!u) return res.status(401).json({ error: 'টেলিগ্রাম যাচাই ব্যর্থ হয়েছে' });
  const id = String(u.id), name = [u.first_name, u.last_name].filter(Boolean).join(' ') || id;
  const rec = USERS[id], admin = isAdminId(id);
  if (!admin && !(rec && rec.active !== false)) {
    const first = !REQS[id];
    if (!rec) { REQS[id] = { id, name, username: u.username || '', at: now() }; persist(); }
    if (first && !rec) ADMIN_IDS.forEach(a => tgSend(a, `নতুন অ্যাক্সেস অনুরোধ: ${name}${u.username ? ' (@' + u.username + ')' : ''}\nআইডি: ${id}\nঅ্যাডমিন প্যানেল থেকে অনুমতি দিন।`));
    return res.status(403).json({ error: 'no_access', id, blocked: !!rec });
  }
  if (admin) SETTINGS.names[id] = name;
  if (rec) { rec.name = name; rec.username = u.username || ''; rec.lastSeen = now(); }
  persist();
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { id, name, exp: now() + 12 * 3600e3 });
  res.json({ token: t });
});
setInterval(() => { for (const [k, v] of tokens) if (v.exp < now()) tokens.delete(k); }, 3600e3);

// পেজ দুটো খোলা (ভেতরে গোপন কিছু নেই), ডাটা এপিআই গেটের পেছনে
const sendPage = f => (req, res) => res.sendFile(path.join(ROOT, f));
['/', '/index.html'].forEach(p => app.get(p, sendPage('index.html')));

app.use((req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'লগইন করুন' });
  if (SETTINGS.maintenance && !u.admin) return res.status(503).json({ error: 'সার্ভিস সাময়িক বন্ধ আছে' });
  req.user = u;
  next();
});
const adminOnly = (req, res, next) => (req.user.admin ? next() : res.status(403).json({ error: 'শুধু অ্যাডমিন পারবেন' }));
app.use('/uploads', adminOnly, express.static(UPLOAD_DIR));

// ---------------------------------------------------------------- আপলোড ও লাইব্রেরি
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      let n = file.originalname.replace(/[^\w.\-]/g, '_').replace(/_+/g, '_');
      if (!path.extname(n)) n += '.mp4';
      cb(null, Date.now() + '-' + n);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_GB * 1024 ** 3 },
  fileFilter: (req, file, cb) => {
    const ok = VIDEO_EXT.has(path.extname(file.originalname).toLowerCase()) || (file.mimetype || '').startsWith('video/');
    ok ? cb(null, true) : cb(new Error('শুধু ভিডিও ফাইল দেওয়া যাবে'));
  },
});

app.post('/upload', (req, res) => {
  const u = req.user;
  if (!u.admin) {
    const q = quotaBytes(u), cl = parseInt(req.headers['content-length'], 10) || 0;
    if (q && userBytes(u.id) + cl > q) { res.set('Connection', 'close'); return res.status(413).json({ error: 'আপনার স্টোরেজ সীমা পার হয়ে যাবে' }); }
  }
  upload.single('video')(req, res, async err => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `ফাইল ${MAX_UPLOAD_GB} GB-এর বেশি বড়`
        : err.message === 'Request aborted' ? 'আপলোড বাতিল হয়েছে' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'ফাইল পাওয়া যায়নি' });
    const meta = await probe(req.file.filename);
    if (!meta.ok) {
      fs.unlink(req.file.path, () => {});
      META.delete(req.file.filename);
      return res.status(400).json({ error: 'এটি বৈধ ভিডিও ফাইল নয়' });
    }
    OWN[req.file.filename] = String(u.id);
    if (!u.admin) {
      const q = quotaBytes(u);
      if (q && userBytes(u.id) > q) {
        fs.unlink(req.file.path, () => {}); META.delete(req.file.filename); delete OWN[req.file.filename]; persist();
        return res.status(413).json({ error: 'আপনার স্টোরেজ সীমা পার হয়ে গেছে' });
      }
    }
    persist();
    log(`আপলোড সম্পন্ন: ${label(req.file.filename)} (${(req.file.size / 1048576).toFixed(1)} MB) — ${u.name}`);
    res.json({ file: req.file.filename, meta });
  });
});

app.get('/files', (req, res) => res.json(listFiles().filter(n => canSee(req.user, n))));   // পুরনো UI-র জন্য সাধারণ তালিকা

app.get('/library', async (req, res) => {
  const out = [];
  for (const n of listFiles()) {
    if (!canSee(req.user, n)) continue;
    const m = await probe(n);
    out.push({ ...m, inUse: S.state !== 'idle' && S.files.includes(n), owner: OWN[n] ? String(OWN[n]) : '', ownerName: OWN[n] ? nameOf(OWN[n]) : '—' });
  }
  res.json(out);
});

app.get('/thumb/:name', async (req, res) => {
  const n = safeName(req.params.name);
  if (!n || (!canSee(req.user, n) && !(S.state === 'live' && S.files.includes(n)))) return res.sendStatus(404);
  try {
    const f = await makeThumb(n);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(f, { dotfiles: 'allow' });
  } catch { res.sendStatus(404); }
});

app.delete('/files/:name', (req, res) => {
  const n = safeName(req.params.name);
  if (!n || !canSee(req.user, n)) return res.status(404).json({ error: 'ফাইল পাওয়া যায়নি' });
  if (S.state !== 'idle' && S.files.includes(n)) return res.status(409).json({ error: 'এই ভিডিও এখন লাইভে ব্যবহার হচ্ছে বা শিডিউল করা আছে' });
  fs.unlinkSync(path.join(UPLOAD_DIR, n));
  META.delete(n); delete OWN[n]; persist();
  fs.rm(path.join(THUMB_DIR, n + '.jpg'), { force: true }, () => {});
  log('ভিডিও মুছে ফেলা হয়েছে: ' + label(n));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- লাইভ কন্ট্রোল
const mine = u => S.state === 'idle' || u.admin || (S.opts && String(S.opts.owner) === String(u.id));
app.post('/start', async (req, res) => {
  try {
    const r = await startStream(req.body || {}, req.user);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.post('/stop', (req, res) => {
  if (!mine(req.user)) return res.status(403).json({ error: 'এটা অন্য ব্যবহারকারীর লাইভ' });
  stopStream('user');
  res.json({ ok: true });
});

app.post('/restart', (req, res) => {
  if (!mine(req.user)) return res.status(403).json({ error: 'এটা অন্য ব্যবহারকারীর লাইভ' });
  if (S.state === 'live' && S.proc) {
    log('হাতে রিস্টার্ট করা হচ্ছে');
    try { S.proc.kill('SIGKILL'); } catch {}
    return res.json({ ok: true });
  }
  if (S.state === 'reconnecting') {
    clearTimeout(S.timers.restart);
    spawnFF();
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'এখন কোনো লাইভ চলছে না' });
});

app.get('/status', (req, res) => res.json(statusObj(req.user)));
app.get('/logs', adminOnly, (req, res) => res.json(LOGS.slice(-clamp(parseInt(req.query.n, 10) || 100, 1, 300))));
app.get('/history', (req, res) => res.json(loadJSON(HIST_FILE, []).filter(h => req.user.admin || String(h.owner) === String(req.user.id)).reverse()));
app.get('/last', (req, res) => { const l = loadJSON(LAST_FILE, {}); l.files = (l.files || []).filter(n => canSee(req.user, n)); res.json(l); });

app.get('/system', adminOnly, (req, res) => {
  let load = [0, 0, 0], cpus = 0, disk = null, used = 0;
  try { load = os.loadavg(); } catch {}
  try { cpus = os.cpus().length; } catch {}
  try { const s = fs.statfsSync(UPLOAD_DIR); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch {}
  for (const n of listFiles()) { try { used += fs.statSync(path.join(UPLOAD_DIR, n)).size; } catch {} }
  res.json({
    load, cpus,
    mem: { total: os.totalmem(), free: os.freemem() },
    disk, uploadsBytes: used,
    node: process.version, uptime: Math.round(process.uptime()),
    auth: !!PASSWORD, maxUploadGB: MAX_UPLOAD_GB,
  });
});

// লাইভ আপডেট (Server-Sent Events): new EventSource('/events')
const clients = new Set();
app.get('/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.user = req.user;
  res.write(`data: ${JSON.stringify(statusObj(req.user))}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => {
  if (!clients.size) return;
  clients.forEach(c => { try { c.write(`data: ${JSON.stringify(statusObj(c.user))}\n\n`); } catch {} });
}, 2000);

// ---------------------------------------------------------------- /me ও অ্যাডমিন প্যানেল এপিআই
app.get('/me', (req, res) => {
  const u = req.user, rec = USERS[u.id] || {};
  res.json({
    id: u.id, name: u.name, admin: !!u.admin, auth: !!PASSWORD,
    usedBytes: userBytes(u.id), quotaBytes: u.admin ? 0 : quotaBytes(u),
    streamSeconds: rec.streamSeconds || 0, canStream: !!u.admin || u.canStream !== false, maxStreamMinutes: u.maxStreamMinutes || 0,
  });
});

function applyUser(u, b) {
  if ('name' in b) u.name = String(b.name || '').slice(0, 60);
  if ('note' in b) u.note = String(b.note || '').slice(0, 200);
  if ('active' in b) u.active = !!b.active;
  if ('canStream' in b) u.canStream = !!b.canStream;
  if ('quotaGB' in b) u.quotaGB = (b.quotaGB === null || b.quotaGB === '') ? null : clamp(parseFloat(b.quotaGB) || 0, 0, 100000);  // null = ডিফল্ট, 0 = সীমাহীন
  if ('maxStreamMinutes' in b) u.maxStreamMinutes = clamp(parseInt(b.maxStreamMinutes, 10) || 0, 0, 60 * 24 * 14);
}
const stopIfOwner = id => { if (S.state !== 'idle' && S.opts && String(S.opts.owner) === String(id)) stopStream('admin'); };

app.get('/admin/users', adminOnly, (req, res) => {
  const us = usage();
  const z = { bytes: 0, files: 0 };
  res.json({
    admins: [...ADMIN_IDS].map(id => ({ id, name: nameOf(id), ...(us[id] || z) })),
    users: Object.entries(USERS).map(([id, u]) => ({ id, ...u, active: u.active !== false, canStream: u.canStream !== false, ...(us[id] || z) })),
    orphan: us['?'] || null,
    requests: Object.values(REQS).sort((a, b) => b.at - a.at),
    defaultQuotaGB: SETTINGS.defaultQuotaGB,
  });
});

app.post('/admin/users', adminOnly, (req, res) => {
  const b = req.body || {}, id = String(b.id || '').trim();
  if (!/^\d{3,15}$/.test(id)) return res.status(400).json({ error: 'টেলিগ্রাম আইডি শুধু সংখ্যা হবে' });
  if (isAdminId(id)) return res.status(400).json({ error: 'এটা অ্যাডমিনের আইডি' });
  const r = REQS[id], old = USERS[id] || {};
  const u = { ...old, name: old.name || (r && r.name) || '', username: old.username || (r && r.username) || '', active: true, added: old.added || now() };
  applyUser(u, { ...b, active: true });
  if (!u.name) u.name = id;
  USERS[id] = u; delete REQS[id]; persist();
  if (!old.added) tgSend(id, 'আপনাকে লাইভ স্টুডিও ব্যবহারের অনুমতি দেওয়া হয়েছে। এখন মিনি অ্যাপ খুলুন।');
  res.json({ ok: true });
});

app.patch('/admin/users/:id', adminOnly, (req, res) => {
  const u = USERS[req.params.id];
  if (!u) return res.status(404).json({ error: 'ইউজার পাওয়া যায়নি' });
  applyUser(u, req.body || {});
  persist();
  if (u.active === false || u.canStream === false) stopIfOwner(req.params.id);
  res.json({ ok: true });
});

app.delete('/admin/users/:id', adminOnly, (req, res) => {
  const id = req.params.id;
  if (!USERS[id]) return res.status(404).json({ error: 'ইউজার পাওয়া যায়নি' });
  stopIfOwner(id);
  let removed = 0;
  if (req.query.files === '1') {
    for (const n of listFiles()) {
      if (String(OWN[n]) !== id || (S.state !== 'idle' && S.files.includes(n))) continue;
      try { fs.unlinkSync(path.join(UPLOAD_DIR, n)); META.delete(n); delete OWN[n]; fs.rm(path.join(THUMB_DIR, n + '.jpg'), { force: true }, () => {}); removed++; } catch {}
    }
  }
  delete USERS[id]; persist();
  log(`ইউজার মুছে ফেলা হয়েছে: ${id}${removed ? ` (${removed}টি ভিডিওসহ)` : ''}`);
  res.json({ ok: true, removed });
});

app.delete('/admin/requests/:id', adminOnly, (req, res) => { delete REQS[req.params.id]; persist(); res.json({ ok: true }); });

app.get('/admin/settings', adminOnly, (req, res) => res.json({ defaultQuotaGB: SETTINGS.defaultQuotaGB, maintenance: SETTINGS.maintenance, support: SETTINGS.support || '', maxUploadGB: MAX_UPLOAD_GB, tg: !!BOT_TOKEN, admins: ADMIN_IDS.size }));
app.post('/admin/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  if ('defaultQuotaGB' in b) SETTINGS.defaultQuotaGB = clamp(parseFloat(b.defaultQuotaGB) || 0, 0, 100000);
  if ('maintenance' in b) SETTINGS.maintenance = !!b.maintenance;
  if ('support' in b) {
    const u = String(b.support || '').trim().replace(/^(https?:\/\/)?(t\.me\/)?@?/i, '');
    if (u && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(u)) return res.status(400).json({ error: 'সাপোর্ট ইউজারনেম ঠিক নয় (যেমন: my_support)' });
    SETTINGS.support = u;
  }
  persist();
  res.json({ ok: true });
});

// ত্রুটি হ্যান্ডলার
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'সার্ভারে সমস্যা হয়েছে' });
});

// ---------------------------------------------------------------- নিরাপদ বন্ধ ও ক্র্যাশ সুরক্ষা
process.on('uncaughtException', e => { if (e && e.message === 'Request aborted') return; log('অপ্রত্যাশিত ত্রুটি: ' + (e && e.message)); });
process.on('unhandledRejection', e => log('অপ্রত্যাশিত ত্রুটি: ' + (e && e.message)));
process.on('exit', () => { if (S.proc) { try { S.proc.kill('SIGKILL'); } catch {} } });
function shutdown() {
  log('সার্ভার বন্ধ হচ্ছে');
  S.userStop = true;
  if (S.proc) { try { S.proc.kill('SIGINT'); } catch {} }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------- চালু
app.listen(PORT, HOST, async () => {
  console.log('');
  console.log(`চালু: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    try {
      Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal)
        .forEach(i => console.log(`অন্য ডিভাইস থেকে: http://${i.address}:${PORT}`));
    } catch {}
  }
  if (BOT_TOKEN) console.log(`টেলিগ্রাম লগইন চালু। অ্যাডমিন: ${ADMIN_IDS.size}জন${ADMIN_IDS.size ? '' : ' (সতর্কতা: ADMIN_IDS দেননি)'}`);
  if (PASSWORD) console.log('পাসওয়ার্ড লগইনও চালু (ব্রাউজার থেকে অ্যাডমিন হিসেবে)।');
  if (openMode) console.log('সতর্কতা: BOT_TOKEN বা PASSWORD নেই — সবাই অ্যাডমিন! শুধু লোকাল টেস্টে চালান।');
  try {
    const v = (await run(FFMPEG, ['-version'], 5000)).split('\n')[0];
    console.log('FFmpeg: ' + v.slice(0, 60));
  } catch {
    console.log('সতর্কতা: FFmpeg পাওয়া যায়নি। চালান: pkg install ffmpeg');
  }
});
