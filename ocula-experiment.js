/* OCULA experiment harness, Phase A (observation only).
   v1.1. Does NOT change OCULA's gaze, smoothing, dwell or calibration logic.
   It reads the page (cursor position, hover class, dwell ring, face warning)
   and records it. Original OCULA: Bukhari (2026), MIT licence. */
(() => {
'use strict';
const TIMEOUT_MS = 6000, ITI_MS = 1500, REPS = 5, FREELOOK_MS = 120000;
const VAL_SETTLE = 800, VAL_SAMPLE = 1000;
const VAL_PTS = [[.1,.15],[.5,.15],[.9,.15],[.1,.5],[.5,.5],[.9,.5],[.1,.85],[.5,.85],[.9,.85]];
const $ = id => document.getElementById(id);
const cursorEl = $('cursor'), faceWarn = $('face-warn'), board = $('board'), dwellC = $('dwell-progress-circle');
const T0 = performance.now();
const now = () => Math.round(performance.now() - T0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let phase = 'idle', trial = '', events = [], samples = [], running = false, abort = false, pending = null;
let faceLost = false, faceLostMs = 0, lastS = performance.now();
let prevFrac = 0, prevHover = '', lastAct = -1e9, lastFound = 0;
const frameDts = [];
let meta = { participant: 'P0', condition: 'A_baseline', distance_cm: '', screen_in: '', lighting: '' };

// ---------- UI ----------
const css = document.createElement('style');
css.textContent = `
#oe-panel{position:fixed;top:12px;left:12px;z-index:40;width:220px;padding:10px;background:rgba(8,8,12,.92);border:1px solid #2c2b27;font:11px/1.5 "JetBrains Mono",monospace;color:#f0ede4;display:none}
#oe-panel input,#oe-panel select{width:100%;margin:2px 0 6px;background:#14141a;color:#f0ede4;border:1px solid #2c2b27;padding:3px;font:inherit}
#oe-panel button{width:100%;margin:2px 0;padding:5px;background:transparent;color:#ffb86b;border:1px solid #ffb86b;font:inherit;cursor:pointer}
#oe-out{white-space:pre-wrap;margin-top:6px;color:#8a877e}
#oe-banner{position:fixed;top:12px;left:12px;z-index:60;pointer-events:none;font:12px "JetBrains Mono",monospace;color:#5eead4}
#oe-val{position:fixed;inset:0;z-index:50;background:#050507}
#oe-dot{position:absolute;width:16px;height:16px;border-radius:50%;background:#ffb86b;transform:translate(-50%,-50%);box-shadow:0 0 16px #ffb86b}
.tile.ocula-target{outline:3px solid #5eead4;outline-offset:-3px}
body.ocula-run .status-bar button{visibility:hidden;pointer-events:none}`;
document.head.appendChild(css);

const panel = document.createElement('div');
panel.id = 'oe-panel';
panel.innerHTML = `
<div>Participant ID<input id="oe-pid" value="P0"></div>
<div>Condition<select id="oe-cond"><option>A_baseline</option><option>B_dispersion</option></select></div>
<div>Distance (cm)<input id="oe-dist" value="50"></div>
<div>Screen diagonal (in)<input id="oe-diag" value="15.6"></div>
<div>Lighting<select id="oe-light"><option>lamp_on</option><option>ambient</option><option>other</option></select></div>
<button id="oe-bval">1. Validation (9 pts)</button>
<button id="oe-bcued">2. Cued trials</button>
<button id="oe-bfree">3. Free look (2 min)</button>
<button id="oe-bdl">Download CSVs now</button>
<div id="oe-out">Calibrate first. Press q to abort a block.</div>`;
document.body.appendChild(panel);
const banner = document.createElement('div');
banner.id = 'oe-banner';
document.body.appendChild(banner);
const setBanner = t => { banner.textContent = t; };
const out = t => { $('oe-out').textContent = t; };

// ---------- helpers ----------
const tileName = el => el.classList.contains('tile')
  ? el.querySelector('.text').textContent : (el.dataset.action || 'control');
const curPos = () => [parseFloat(cursorEl.style.left) || 0, parseFloat(cursorEl.style.top) || 0];
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function readMeta() {
  meta = { participant: $('oe-pid').value.trim() || 'P0', condition: $('oe-cond').value,
    distance_cm: $('oe-dist').value, screen_in: $('oe-diag').value, lighting: $('oe-light').value };
  window.__OCULA_MODE = meta.condition.startsWith('B') ? 'B' : 'A';
}
function log(event, o = {}) {
  events.push({ t_ms: now(), p: meta.participant, cond: meta.condition, phase, trial, event, ...o });
}
const q = v => { v = (v === undefined || v === null) ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCsv = (cols, rows) => cols.join(',') + '\n' + rows.map(r => cols.map(c => q(r[c])).join(',')).join('\n');
function save(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function download(tag) {
  const base = `ocula_${meta.participant}_${meta.condition}_${tag}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  save(base + '_events.csv', toCsv(['t_ms','p','cond','phase','trial','event','target','tile','outcome','latency_ms','activated','x','y','frac','info'], events));
  save(base + '_samples.csv', toCsv(['t_ms','p','cond','phase','trial','x','y','hover','dwell_frac','face_ok'], samples));
}

// ---------- observation loop ----------
function loop() {
  requestAnimationFrame(loop);
  const t = performance.now(), dt = t - lastS; lastS = t;
  const st = document.body.dataset.state;
  const f = window.__oculaFace;  // frame-level face state from the index.html hook
  const lost = st === 'tracking' && (f ? (!f.ok || t - f.t > 300) : faceWarn.classList.contains('show'));
  if (lost !== faceLost) { faceLost = lost; if (!lost) lastFound = now(); if (running) log(lost ? 'face_lost' : 'face_found'); }
  if (frameDts.length < 300) frameDts.push(dt);
  if (lost && running) faceLostMs += dt;
  panel.style.display = ((st === 'tracking' || st === 'welcome') && !running) ? 'block' : 'none';
  if (phase === 'idle' || st !== 'tracking') return;
  const [x, y] = curPos();
  const h = document.querySelector('.tile.gazed, .gaze-clickable.gazed');
  const hid = h ? tileName(h) : '';
  const off = parseFloat(dwellC.style.strokeDashoffset);
  const frac = isNaN(off) ? 0 : Math.max(0, Math.min(1, 1 - off / 169.6));
  samples.push({ t_ms: now(), p: meta.participant, cond: meta.condition, phase, trial,
    x: Math.round(x), y: Math.round(y), hover: hid, dwell_frac: frac.toFixed(3), face_ok: lost ? 0 : 1 });
  if (prevFrac > 0.05 && frac === 0 && (now() - lastAct) > 150) {
    log('dwell_reset', { tile: prevHover, frac: prevFrac.toFixed(3),
      info: hid !== prevHover ? 'inferred=left_or_changed_element' : (window.__OCULA_MODE === 'B' ? 'inferred=unknown' : 'inferred=anchor_radius_exceeded') });
  }
  prevFrac = frac; prevHover = hid;
}

// OCULA fires activations with el.click() (isTrusted === false); real mouse clicks are ignored.
document.addEventListener('click', e => {
  if (e.isTrusted) return;
  const el = e.target.closest && e.target.closest('.tile,[data-action]');
  if (!el) return;
  const t = now(); lastAct = t;
  const idx = [...board.children].indexOf(el);
  const [x, y] = curPos();
  log('activation', { tile: tileName(el), activated: idx, x: Math.round(x), y: Math.round(y), info: 'since_face_found_ms=' + (t - lastFound) });
  if (pending) { const p = pending; pending = null; p.resolve({ idx, t, name: tileName(el) }); }
}, true);

addEventListener('keydown', e => {
  if (e.key === 'q' && running) {
    abort = true;
    if (pending) { const p = pending; pending = null; p.resolve(null); }
  }
});

// ---------- block control ----------
async function begin(name) {
  if (running) return false;
  if (document.body.dataset.state !== 'tracking') { alert('Finish calibration first (Begin Calibration, then wait for the board).'); return false; }
  readMeta(); running = true; abort = false; phase = 'idle'; trial = ''; prevFrac = 0; prevHover = '';
  document.body.classList.add('ocula-run');
  const tl = board.children[0].getBoundingClientRect();
  log('block_start', { info: `block=${name};mode=${window.__OCULA_MODE};bparams=${JSON.stringify(window.__OCULA_BPARAMS || {})};raf_ms=${median(frameDts).toFixed(1)};dwell_setting=${$('dwell-display').textContent};distance_cm=${meta.distance_cm};screen_in=${meta.screen_in};lighting=${meta.lighting};viewport=${innerWidth}x${innerHeight};screen=${screen.width}x${screen.height};dpr=${devicePixelRatio};tile_px=${Math.round(tl.width)}x${Math.round(tl.height)};ua=${navigator.userAgent}` });
  for (let s = 3; s > 0; s--) { setBanner(`${name} starts in ${s}...`); await sleep(1000); }
  return true;
}
function finish(name) {
  phase = 'idle'; trial = '';
  log('block_end', { info: 'block=' + name + (abort ? ';ABORTED' : '') });
  setBanner(''); document.body.classList.remove('ocula-run'); running = false;
  download(name);
}

// ---------- 1. validation ----------
async function runValidation() {
  if (!await begin('validation')) return;
  phase = 'validation';
  const ov = document.createElement('div');
  ov.id = 'oe-val'; ov.innerHTML = '<div id="oe-dot"></div>';
  document.body.appendChild(ov);
  const dot = ov.firstChild, errs = [];
  for (let i = 0; i < VAL_PTS.length && !abort; i++) {
    const tx = VAL_PTS[i][0] * innerWidth, ty = VAL_PTS[i][1] * innerHeight;
    dot.style.left = tx + 'px'; dot.style.top = ty + 'px'; trial = 'v' + (i + 1);
    setBanner(`Validation ${i + 1}/9: look at the dot`);
    await sleep(VAL_SETTLE);
    const xs = [], ys = [], tEnd = performance.now() + VAL_SAMPLE;
    while (performance.now() < tEnd) { if (!faceLost) { const [x, y] = curPos(); xs.push(x); ys.push(y); } await sleep(33); }
    const dx = median(xs) - tx, dy = median(ys) - ty, err = Math.hypot(dx, dy);
    if (xs.length >= 5) errs.push(err);
    log('val_point', { target: i + 1, x: Math.round(tx), y: Math.round(ty), info: `n=${xs.length};dx=${dx.toFixed(1)};dy=${dy.toFixed(1)};err_px=${err.toFixed(1)}` });
  }
  ov.remove();
  const mean = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
  const dist = parseFloat(meta.distance_cm), diag = parseFloat(meta.screen_in);
  let deg = '';
  if (dist > 0 && diag > 0) {
    const pxPerCm = Math.hypot(screen.width, screen.height) / (diag * 2.54);
    deg = (Math.atan((mean / pxPerCm) / dist) * 180 / Math.PI).toFixed(2);
  }
  log('val_summary', { info: `points_ok=${errs.length}/9;mean_err_px=${mean.toFixed(1)};median_err_px=${median(errs).toFixed(1)};mean_err_deg=${deg}` });
  out(`Validation: ${errs.length}/9 points usable\nmean error ${mean.toFixed(0)} px${deg ? ' (~' + deg + ' deg)' : ''}`);
  finish('validation');
}

// ---------- 2. cued trials ----------
function makeOrder(n, reps) {
  let a;
  do {
    a = [];
    for (let r = 0; r < reps; r++) for (let i = 0; i < n; i++) a.push(i);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  } while (n > 1 && a.some((v, i) => i && v === a[i - 1]));
  return a;
}
async function oneTrial(i, total, target, tiles) {
  const el = tiles[target], t0 = now(), loss0 = faceLostMs;
  setBanner(`Trial ${i}/${total}`);
  el.classList.add('ocula-target');
  log('cue', { target, tile: tileName(el) });
  const r = await new Promise(res => {
    const p = { resolve: res }; pending = p;
    setTimeout(() => { if (pending === p) { pending = null; res(null); } }, TIMEOUT_MS);
  });
  el.classList.remove('ocula-target');
  if (abort) return null;
  let outcome = 'timeout', lat = '';
  if (r) { outcome = r.idx === target ? 'success' : 'wrong'; lat = r.t - t0; }
  log('trial_end', { target, tile: tileName(el), outcome, latency_ms: lat, activated: r ? r.name : '', info: 'face_lost_ms=' + Math.round(faceLostMs - loss0) });
  return { outcome, lat, loss: faceLostMs - loss0 };
}
async function runCued() {
  if (!await begin('cued')) return;
  phase = 'cued';
  const tiles = [...board.children], order = makeOrder(tiles.length, REPS), res = [];
  log('trial_order', { info: order.join('') });
  for (let i = 0; i < order.length && !abort; i++) {
    trial = i + 1;
    res.push(await oneTrial(i + 1, order.length, order[i], tiles));
    trial = '';
    if (!abort) await sleep(ITI_MS);
  }
  const done = res.filter(Boolean), c = o => done.filter(r => r.outcome === o).length;
  const med = median(done.filter(r => r.outcome === 'success').map(r => r.lat));
  const unint = events.filter(e => e.phase === 'cued' && e.event === 'activation' && e.trial === '').length;
  const loss = Math.round(done.reduce((a, r) => a + r.loss, 0));
  out(`Cued: ${done.length} trials\nsuccess ${c('success')} | wrong ${c('wrong')} | timeout ${c('timeout')}\nmedian latency (success) ${isNaN(med) ? '-' : Math.round(med)} ms\nunintended between trials ${unint}\nface lost ${loss} ms`);
  finish('cued');
}

// ---------- 3. free look ----------
async function runFree() {
  if (!await begin('freelook')) return;
  phase = 'freelook'; trial = '';
  const t0 = performance.now(), loss0 = faceLostMs;
  while (performance.now() - t0 < FREELOOK_MS && !abort) {
    const s = Math.ceil((FREELOOK_MS - (performance.now() - t0)) / 1000);
    setBanner(`Free look: ${s}s left. Look around the board naturally. Do not try to select anything.`);
    await sleep(250);
  }
  const mins = (performance.now() - t0) / 60000;
  const acts = events.filter(e => e.phase === 'freelook' && e.event === 'activation').length;
  out(`Free look: ${mins.toFixed(1)} min\nactivations ${acts} (${(acts / mins).toFixed(1)} per min)\nface lost ${Math.round(faceLostMs - loss0)} ms`);
  finish('freelook');
}

$('oe-bval').onclick = runValidation;
$('oe-bcued').onclick = runCued;
$('oe-bfree').onclick = runFree;
$('oe-bdl').onclick = () => { readMeta(); download('manual'); };
requestAnimationFrame(loop);
})();
