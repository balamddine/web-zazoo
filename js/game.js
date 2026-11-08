/* Zazoo game logic */
(() => {
'use strict';
/* ---------------- Sprite sheets ---------------- */
const SHEETS = {
  n_idle:[30,12.5,1], n_bored:[55,12.5,0], n_kiss:[55,12.5,0], n_laugh:[55,12.5,0], n_shout:[55,12.5,0],
  n_slap:[55,12.5,0], n_sleep:[30,7,1], n_eat:[78,12.5,0], n_tofat:[55,12.5,0],
  f_idle:[30,12.5,1], f_kiss:[48,12.5,0], f_slap:[48,12.5,0], f_tap:[30,20,0], f_sleep:[30,7,1],
  f_eat:[78,12.5,0], f_shout:[55,12.5,0]
};
const CELL = 480, COLS = 10;
const ANIM_SPEED = 1.5; // >1 = faster animations
const img = {};
/* HD backend: transparent WebM (VP9 + alpha) at 960px. Safari / iOS cannot show alpha WebM, so they use the sheets. */
// Original white-background renders as H.264 MP4: plays in every modern browser incl. iPhone/Safari
let USE_VIDEO = true;
// [native video fps, sheet frames per second of native time]
const VID = { n_idle: [25, 12.5], n_sleep: [25, 12.5], f_idle: [25, 12.5], f_sleep: [25, 12.5], f_tap: [25, 25] };
const vinfo = k => VID[k.replace('n_fromfat', 'n_tofat')] || [12.5, 12.5];
const vurl = {};
const VNAMES = [...Object.keys(SHEETS), 'n_fromfat'];
async function loadVideoData(k) {
  if (location.protocol === 'file:') { vurl[k] = 'sprites/' + k + '.mp4'; return; }
  try { const r = await fetch('sprites/' + k + '.mp4'); if (!r.ok) throw 0; vurl[k] = URL.createObjectURL(await r.blob()); }
  catch (e) { vurl[k] = 'sprites/' + k + '.mp4'; }     // file:// can't fetch: stream from disk instead
}
const pool = [0, 1].map(() => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); return v; });
let vActive = null;                        // video currently drawn
function startVideo(name, rate, loop) {
  const v = pool.find(x => x !== vActive);
  v.onplaying = null; v.loop = loop; v.src = vurl[name]; v.defaultPlaybackRate = v.playbackRate = rate;
  const token = {};
  v._token = token;
  v.onplaying = () => { if (v._token !== token) return; v.playbackRate = rate; if (vActive && vActive !== v) vActive.pause(); vActive = v; if (cur && cur.vtoken === token) cur.ready = true; };
  v.play().catch(() => {});
  return token;
}
const loadSheet = k => new Promise((res, rej) => {
  const i = new Image(); i.decoding = 'async';
  i.onload = () => { img[k] = i; res(); }; i.onerror = () => rej(k); i.src = 'sprites/' + k + '.webp';
});
const FIRST = ['n_idle', 'f_idle', 'n_sleep', 'f_sleep'];
function videoWorks() {                    // make sure HD video really plays here, else fall back
  return new Promise(res => {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = vurl.n_idle;
    const t = setTimeout(() => res(false), 6000);
    v.onloadeddata = () => { clearTimeout(t); res(true); }; v.onerror = () => { clearTimeout(t); res(false); };
  });
}
const loadAll = async () => {
  if (USE_VIDEO) {
    await Promise.all(FIRST.map(loadVideoData));
    if (await videoWorks()) {
      VNAMES.filter(k => !FIRST.includes(k)).reduce((p, k) => p.then(() => loadVideoData(k)), Promise.resolve());
      return;
    }
    USE_VIDEO = false;
  }
  await Promise.all(FIRST.map(loadSheet));
  Object.keys(SHEETS).filter(k => !FIRST.includes(k)).reduce((p, k) => p.then(() => loadSheet(k).catch(() => {})), Promise.resolve());
};

/* ---------------- Tunables (seconds of game time) ---------------- */
const CFG = {
  hungerDecay: 100 / (20 * 60),   // full -> empty in ~20 min
  energyDecay: 100 / (40 * 60),   // awake: ~40 min to empty
  energyGain:  100 / (4 * 60),    // asleep: refills in ~4 min
  happyDecay:  100 / (30 * 60),
  hungryAt: 35,                   // asks for food (notification)
  nagAfter: 90,                   // seconds of ignored hunger before nagging
  nagEvery: 25,                   // seconds between nags
  feedAmount: 28,
  overfullAt: 85,                 // feeding while above this = overeating
  weightPerOvereat: 34,           // 3 overeats -> fat
  fatAt: 100, slimAt: 15,
  digest: 100 / (6 * 60),         // weight lost per second (fat -> slim in ~6 min)
  sleepyAt: 15,
};

/* ---------------- State ---------------- */
const SAVE_KEY = 'zazoo-save-v1';
const fresh = () => ({ hunger: 70, energy: 80, happy: 70, weight: 0, fat: false, asleep: false,
                       hungrySince: null, lastNag: 0, notified: false, t: Date.now() });
let S = fresh();
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (s) S = Object.assign(fresh(), s); } catch (e) {}
const save = () => { try { S.t = Date.now(); localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {} };
let speed = 1;
let gameClock = 0; // seconds of game time since load (for nag scheduling)

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const cv = $('zazoo'), cx = cv.getContext('2d');
const fx = $('fx'), fcx = fx.getContext('2d');
const stage = $('stage');
const W = fx.width;      // effects layer coordinate space
const CW = cv.width;     // character layer (higher res)

/* ---------------- Animation player ---------------- */
let cur = null; // {name, f, acc, reverse, onEnd, busy}
function prefix() { return S.fat ? 'f_' : 'n_'; }
function idleName() { return prefix() + (S.asleep ? 'sleep' : 'idle'); }
function play(name, { reverse = false, onEnd = null, busy = true } = {}) {
  const [n, fps, loop] = SHEETS[name];
  if (USE_VIDEO) {
    const vname = reverse && name === 'n_tofat' ? 'n_fromfat' : name;
    if (!vurl[vname]) { if (onEnd) setTimeout(onEnd, 0); return; }   // still downloading
    const [vf, sf] = vinfo(vname);
    const rate = ANIM_SPEED * fps / sf;
    cur = { name, vname, f: 0, reverse, onEnd, busy, ready: false, sf };
    cur.vtoken = startVideo(vname, rate, !!loop);
    return;
  }
  if (!img[name]) { if (onEnd) setTimeout(onEnd, 0); return; }   // sheet still downloading
  cur = { name, f: reverse ? n - 1 : 0, acc: 0, reverse, onEnd, busy };
}
function toIdle() { play(idleName(), { busy: false }); }
let workout = null; // procedural exercise animation
const busy = () => !!workout || (cur && cur.busy);

function stepAnim(dt) {
  if (!cur) return;
  const [n, fps, loop] = SHEETS[cur.name];
  if (USE_VIDEO) {
    if (!cur.ready || !vActive) return;
    const v = vActive;
    const f = Math.min(n - 1, Math.floor(v.currentTime * cur.sf));
    cur.f = cur.reverse ? n - 1 - f : f;
    if (!loop && v.ended) { const cb = cur.onEnd; toIdle(); if (cb) cb(); }
    return;
  }
  cur.acc += dt * fps * ANIM_SPEED;
  while (cur.acc >= 1) {
    cur.acc -= 1;
    cur.f += cur.reverse ? -1 : 1;
    if (cur.f >= n || cur.f < 0) {
      if (loop) { cur.f = cur.reverse ? n - 1 : 0; }
      else {
        cur.f = Math.max(0, Math.min(n - 1, cur.f));
        const cb = cur.onEnd; toIdle(); if (cb) cb(); return;
      }
    }
  }
}
// "alive" layer: lean toward the pointer, gentle sway while idle
let lean = 0, leanTarget = 0, aliveT = 0;
stage.addEventListener('pointermove', e => { const r = stage.getBoundingClientRect(); leanTarget = ((e.clientX - r.left) / r.width - .5) * .07; });
stage.addEventListener('pointerleave', () => { leanTarget = 0; });
function drawSrc(dx, dy, dw, dh) {
  if (USE_VIDEO) { if (vActive && vActive.readyState >= 2) cx.drawImage(vActive, dx, dy, dw, dh); return; }
  const sheet = img[cur.name]; if (!sheet) return;
  const f = cur.f, sx = (f % COLS) * CELL, sy = Math.floor(f / COLS) * CELL;
  cx.drawImage(sheet, sx, sy, CELL, CELL, dx, dy, dw, dh);
}
function drawChar(dt = 0) {
  if (!cur) return;
  if (USE_VIDEO ? !(vActive && vActive.readyState >= 2) : !img[cur.name]) return;   // keep last frame
  aliveT += dt;
  const idle = !busy() && !S.asleep, asleep = S.asleep && !busy();
  lean += ((idle ? leanTarget : 0) - lean) * Math.min(1, dt * 4);
  cx.clearRect(0, 0, CW, CW);
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  const base = CW * (S.fat ? .872 : .884);
  let h = 0, sy2 = 1, rot = 0;
  if (workout) {
    // Exercise: jumping with squash & stretch (generated on canvas, no source frames needed)
    const per = workout.dur / workout.jumps, p = (workout.t % per) / per;
    if (p < .18) sy2 = 1 - .16 * Math.sin(p / .18 * Math.PI);                 // crouch
    else if (p > .82) sy2 = 1 - .16 * Math.sin((p - .82) / .18 * Math.PI);    // land
    else { const q = (p - .18) / .64; h = Math.sin(q * Math.PI) * CW * (S.fat ? .09 : .17); sy2 = 1 + .07 * Math.sin(q * Math.PI); }
  } else if (idle) {
    rot = Math.sin(aliveT * 1.1) * .012 + lean;                                // gentle sway + lean
  } else if (asleep) {
    sy2 = 1 + Math.sin(aliveT * 1.6) * .012;                                   // deep slow breaths
  }
  const sx2 = 2 - sy2;
  // soft contact shadow grounds him (reads as 3D)
  const sw = CW * (S.fat ? .34 : .27) * (1 - h / CW * 1.2) * (sx2);
  const g = cx.createRadialGradient(CW / 2, base, 0, CW / 2, base, sw);
  g.addColorStop(0, `rgba(10,30,40,${.34 - h / CW * .9})`); g.addColorStop(.6, `rgba(10,30,40,${.12 - h / CW * .3})`); g.addColorStop(1, 'rgba(10,30,40,0)');
  cx.save(); cx.fillStyle = g; cx.setTransform(1, 0, 0, .16, 0, base * (1 - .16)); cx.beginPath(); cx.arc(CW / 2, base, sw, 0, Math.PI * 2); cx.fill(); cx.restore();
  // character, pivoting at the feet
  cx.save();
  cx.globalCompositeOperation = 'multiply';
  cx.translate(CW / 2, base - h); cx.rotate(rot); cx.scale(sx2, sy2);
  drawSrc(-CW / 2, -base, CW, CW);
  cx.restore();
}
function stepWorkout(dt) {
  if (!workout) return;
  const per = workout.dur / workout.jumps;
  const prevT = workout.t; workout.t += dt;
  const k0 = Math.floor(prevT / per), k1 = Math.floor(workout.t / per);
  const p0 = (prevT % per) / per, p1 = (workout.t % per) / per;
  if ((p0 < .18 && p1 >= .18) || (k1 > k0 && p1 >= .18)) sfx.boing();
  if (k1 > k0) {
    sfx.thud();
    addPart({ kind: 'text', txt: k1 + '!', x: W * (.25 + (k1 % 2) * .5), y: W * .3, vy: -40, life: .8, size: 46, col: '#2e9d5b' });
    for (let i = 0; i < 2; i++) addPart({ kind: 'sweat', x: W * (.32 + Math.random() * .36), y: W * .28, vx: (Math.random() - .5) * 160, vy: -120, g: 500, life: .9 });
    if (S.fat && k1 === 3) say('Huff… puff…');
  }
  if (workout.t >= workout.dur) {
    workout = null;
    S.energy = Math.max(0, S.energy - 15); S.hunger = Math.max(0, S.hunger - 8);
    S.happy = Math.min(100, S.happy + 10);
    const lost = S.fat ? 30 : 15; S.weight = Math.max(0, S.weight - lost);
    sfx.cheer(); say(S.fat ? 'I feel lighter!' : 'That was fun!');
    log(`Great workout! Weight −${lost}${S.fat && S.weight > CFG.slimAt ? ' (keep going to slim down)' : ''}.`);
    play(S.fat ? 'f_tap' : 'n_laugh'); save();
  }
}
function exercise() {
  if (busy()) return;
  closeTray();
  if (S.asleep) wake('Up and at it, Zazoo!');
  if (S.energy < 20) { say('Too tired…'); log('Zazoo needs some sleep before exercising.'); sfx.wobble(); return; }
  if (S.hunger < 15) { say('Too hungry…'); log('Feed Zazoo first, he has no energy.'); sfx.grumble(); return; }
  toIdle(); workout = { t: 0, dur: S.fat ? 4.2 : 3.4, jumps: 6 };
  log(S.fat ? 'Jumping jacks! This will help him slim down.' : 'Jump, jump, jump!');
}

/* ---------------- Effects layer (canvas-drawn) ---------------- */
const parts = [];
const mouth = () => S.fat ? { x: W * .5, y: W * .485 } : { x: W * .5, y: W * .545 };
function addPart(p) { parts.push(Object.assign({ t: 0, life: 1.5, vx: 0, vy: 0, g: 0, r: 0, vr: 0, s: 1 }, p)); }

function drawHeart(c, x, y, s, col) {
  c.save(); c.translate(x, y); c.scale(s, s); c.fillStyle = col; c.beginPath();
  c.moveTo(0, 6); c.bezierCurveTo(-14, -4, -8, -16, 0, -8); c.bezierCurveTo(8, -16, 14, -4, 0, 6); c.fill(); c.restore();
}
/* ---- Foods (all drawn with canvas) ---- */
const FOODS = {
  apple:  { name: 'Apple',  food: 18, happy: 4,  weight: -8,  tag: 'healthy', say: 'Crunchy!',          crumb: '#e84a4a' },
  carrot: { name: 'Carrot', food: 14, happy: 2,  weight: -10, tag: 'healthy', say: 'Healthy… I guess.', crumb: '#f28c28' },
  cookie: { name: 'Cookie', food: 24, happy: 8,  weight: 6,   tag: 'treat',   say: 'Yum!',              crumb: '#b07a35' },
  pizza:  { name: 'Pizza',  food: 38, happy: 10, weight: 14,  tag: 'junk',    say: 'Pizza party!',      crumb: '#e8b84a' },
  cake:   { name: 'Cake',   food: 30, happy: 16, weight: 18,  tag: 'junk',    say: 'Sugar rush!',       crumb: '#f7a8c4' },
};
const circle = (c, x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); };
const FOOD_DRAW = {
  cookie(c, r) {
    c.fillStyle = '#d9a35b'; circle(c, 0, 0, r);
    c.lineWidth = r * .08; c.strokeStyle = '#b07a35'; c.stroke();
    c.fillStyle = '#5a3418';
    [[-.4, -.3], [.2, -.5], [.35, .2], [-.15, .35], [-.5, .25], [.05, -.05]].forEach(([a, b]) => circle(c, a * r, b * r, r * .11));
  },
  apple(c, r) {
    c.fillStyle = '#e53935'; circle(c, -r * .35, r * .05, r * .68); circle(c, r * .35, r * .05, r * .68);
    c.fillStyle = '#ff8a80'; circle(c, -r * .45, -r * .2, r * .16);
    c.strokeStyle = '#6d4c2f'; c.lineWidth = r * .12; c.lineCap = 'round';
    c.beginPath(); c.moveTo(0, -r * .45); c.quadraticCurveTo(r * .05, -r * .8, r * .15, -r * .95); c.stroke();
    c.fillStyle = '#43a047'; c.beginPath(); c.ellipse(r * .38, -r * .8, r * .28, r * .13, -.5, 0, Math.PI * 2); c.fill();
  },
  carrot(c, r) {
    c.save(); c.rotate(-.6);
    c.fillStyle = '#43a047';
    for (const a of [-.35, 0, .35]) { c.save(); c.translate(0, -r * .7); c.rotate(a); c.beginPath(); c.ellipse(0, -r * .3, r * .12, r * .35, 0, 0, 7); c.fill(); c.restore(); }
    c.fillStyle = '#fb8c00'; c.beginPath(); c.moveTo(-r * .32, -r * .7); c.quadraticCurveTo(0, -r * .85, r * .32, -r * .7); c.lineTo(0, r * 1.05); c.closePath(); c.fill();
    c.strokeStyle = '#e65100'; c.lineWidth = r * .06;
    for (const y of [-.35, 0, .35]) { c.beginPath(); c.moveTo(-r * .2 * (1 - y), r * y); c.lineTo(-r * .02, r * y + r * .04); c.stroke(); }
    c.restore();
  },
  pizza(c, r) {
    c.fillStyle = '#f9c74f'; c.beginPath(); c.moveTo(-r * .85, -r * .55); c.lineTo(r * .85, -r * .55); c.lineTo(0, r * .95); c.closePath(); c.fill();
    c.fillStyle = '#c8873a'; c.beginPath(); c.moveTo(-r * .95, -r * .55); c.quadraticCurveTo(0, -r * 1.05, r * .95, -r * .55); c.quadraticCurveTo(0, -r * .7, -r * .95, -r * .55); c.fill();
    c.fillStyle = '#c62828'; [[-.3, -.25], [.3, -.2], [0, .25], [-.05, -.3]].slice(0, 3).forEach(([a, b]) => circle(c, a * r, b * r, r * .16));
  },
  cake(c, r) {
    c.fillStyle = '#fff3e0'; c.beginPath(); c.moveTo(-r * .9, -r * .2); c.lineTo(r * .9, -r * .45); c.lineTo(r * .9, r * .7); c.lineTo(-r * .9, r * .7); c.closePath(); c.fill();
    c.fillStyle = '#f48fb1'; c.fillRect(-r * .9, r * .05, r * 1.8, r * .18); c.fillRect(-r * .9, r * .4, r * 1.8, r * .14);
    c.fillStyle = '#fce4ec'; c.beginPath(); c.moveTo(-r * .95, -r * .2); c.lineTo(r * .95, -r * .5); c.lineTo(r * .95, -r * .3); c.lineTo(-r * .95, 0); c.fill();
    c.fillStyle = '#d32f2f'; circle(c, r * .15, -r * .6, r * .2);
    c.strokeStyle = '#2e7d32'; c.lineWidth = r * .06; c.beginPath(); c.moveTo(r * .15, -r * .78); c.quadraticCurveTo(r * .25, -r * 1, r * .4, -r * 1.05); c.stroke();
  },
};
function drawFood(c, kind, x, y, r, bites = 0) {
  c.save(); c.translate(x, y);
  (FOOD_DRAW[kind] || FOOD_DRAW.cookie)(c, r);
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < bites; i++) circle(c, r * (1 - i * .55), -r * .2 + i * r * .25, r * .55);
  c.restore();
}
function drawAnger(c, x, y, s) {
  c.save(); c.translate(x, y); c.scale(s, s); c.strokeStyle = '#e53935'; c.lineWidth = 6; c.lineCap = 'round';
  for (let i = 0; i < 4; i++) { c.rotate(Math.PI / 2); c.beginPath(); c.moveTo(6, 6); c.quadraticCurveTo(14, 4, 16, 14); c.stroke(); }
  c.restore();
}
function drawText(c, x, y, txt, size, col, alpha) {
  c.save(); c.globalAlpha = alpha; c.font = `800 ${size}px ui-rounded, Nunito, system-ui, sans-serif`; c.textAlign = 'center';
  c.lineWidth = size * .18; c.strokeStyle = '#fff'; c.strokeText(txt, x, y); c.fillStyle = col; c.fillText(txt, x, y); c.restore();
}

// Cookie that flies into the mouth during the eat animation
let food = null; // {t, bites}
function stepFx(dt) {
  fcx.clearRect(0, 0, W, W);
  // eat cookie synced to frames of the eat animation
  if (cur && cur.name.endsWith('_eat')) {
    const f = cur.f, m = mouth();
    const bites = f < 12 ? 0 : f < 36 ? 1 : f < 60 ? 2 : 3;  // bites land when the mouth closes
    if (bites < 3) {
      const k = Math.min(1, f / 7);              // fly-in progress
      const e = 1 - Math.pow(1 - k, 3);
      const x = W * .92 + (m.x + W * .02 - W * .92) * e;
      const y = W * 1.05 + (m.y - W * 1.05) * e - Math.sin(e * Math.PI) * W * .25;
      drawFood(fcx, curFood, x, y, W * .075, bites);
    }
    if (food && food.bites !== bites && bites > 0) {
      const col = (FOODS[curFood] || FOODS.cookie).crumb;
      for (let i = 0; i < 8; i++) addPart({ kind: 'crumb', col, x: m.x + (Math.random() - .5) * 60, y: m.y + 10, vx: (Math.random() - .5) * 180, vy: -Math.random() * 120, g: 600, life: .9, r: 3 + Math.random() * 4 });
      sfx.bite(curFood);
    }
    food = { bites };
  } else food = null;

  // ambient: Zzz while sleeping, anger while nagging
  if (S.asleep && Math.random() < dt * 1.1) addPart({ kind: 'z', x: W * .66, y: W * .3, vx: 35, vy: -45, life: 2.6, s: 1 + Math.random() * .6 });
  if (cur && cur.name.endsWith('_shout') && Math.random() < dt * 5) addPart({ kind: 'anger', x: W * (.25 + Math.random() * .5), y: W * (.15 + Math.random() * .15), life: .6, s: 1 + Math.random() });

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.t += dt; if (p.t > p.life) { parts.splice(i, 1); continue; }
    p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += 0;
    const a = 1 - p.t / p.life;
    if (p.kind === 'heart') drawHeart(fcx, p.x, p.y, p.s * (1 + p.t * .4), `rgba(255,95,135,${a})`);
    else if (p.kind === 'crumb') { fcx.globalAlpha = a; fcx.fillStyle = p.col || '#b07a35'; fcx.beginPath(); fcx.arc(p.x, p.y, p.r, 0, 7); fcx.fill(); fcx.globalAlpha = 1; }
    else if (p.kind === 'sweat') { fcx.save(); fcx.globalAlpha = a; fcx.fillStyle = '#7fc8ff'; fcx.translate(p.x, p.y); fcx.beginPath(); fcx.moveTo(0, -12); fcx.quadraticCurveTo(9, 2, 0, 8); fcx.quadraticCurveTo(-9, 2, 0, -12); fcx.fill(); fcx.restore(); }
    else if (p.kind === 'z') drawText(fcx, p.x + Math.sin(p.t * 3) * 10, p.y, 'Z', 40 * p.s, '#5b5fc7', a);
    else if (p.kind === 'anger') drawAnger(fcx, p.x, p.y, p.s * (0.6 + Math.min(p.t * 4, 1) * .6));
    else if (p.kind === 'text') drawText(fcx, p.x, p.y, p.txt, p.size || 42, p.col || '#24343a', a);
    else if (p.kind === 'star') drawText(fcx, p.x, p.y, '✦', 30 * p.s, '#ffb547', a);
  }
}

/* ---------------- Sounds (tiny WebAudio blips) ---------------- */
let ac = null, master = null, noiseBuf = null;
let muted = false; try { muted = localStorage.getItem('zazoo-muted') === '1'; } catch (e) {}
function audio() {
  if (muted) return null;
  try {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      master = ac.createGain(); master.gain.value = .9; master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  } catch (e) { return null; }
}
// oscillator blip: freq -> freq+slide over dur, optional vibrato
function tone(freq, dur = .12, type = 'sine', vol = .08, slide = 0, delay = 0, vib = 0) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  if (vib) { const l = a.createOscillator(), lg = a.createGain(); l.frequency.value = vib; lg.gain.value = freq * .08; l.connect(lg).connect(o.frequency); l.start(t); l.stop(t + dur); }
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + .02);
}
// filtered noise burst
function noise(dur = .1, freq = 1500, vol = .1, delay = 0, type = 'bandpass', q = 1, attack = .005) {
  const a = audio(); if (!a) return;
  const t = a.currentTime + delay, s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t, Math.random() * .5); s.stop(t + dur + .02);
}
const sfx = {
  click()   { tone(900, .05, 'triangle', .04); },
  chime()   { tone(784, .18, 'sine', .09); tone(1047, .25, 'sine', .08, 0, .14); tone(1319, .3, 'sine', .06, 0, .28); },
  bite(kind) {
    if (kind === 'apple' || kind === 'carrot') { noise(.08, 3200, .22, 0, 'bandpass', 2); noise(.06, 2400, .16, .05, 'bandpass', 2); }
    else if (kind === 'cake') { noise(.12, 600, .14, 0, 'lowpass', 1, .02); }
    else { noise(.07, 1800, .16, 0, 'bandpass', 1.5); tone(160, .08, 'square', .03, -60); }
  },
  yum()     { tone(500, .12, 'triangle', .07, 150); tone(650, .18, 'triangle', .07, 200, .12); },
  giggle()  { [0, .09, .18, .27].forEach((d, i) => tone(620 + i * 90 + Math.random() * 40, .08, 'triangle', .06, 80, d)); },
  jiggle()  { tone(180, .35, 'sine', .1, 0, 0, 14); },
  ouch()    { tone(700, .25, 'sawtooth', .05, -400); noise(.05, 2500, .15); },
  smack()   { noise(.04, 3500, .22, 0, 'highpass', 1); tone(1200, .06, 'sine', .05, -500, .02); },
  kiss()    { sfx.smack(); setTimeout(sfx.smack, 260); [0, .1, .2].forEach((d, i) => tone(1046 + i * 262, .2, 'sine', .04, 0, .5 + d)); },
  grumble() { tone(140, .5, 'sawtooth', .07, -40, 0, 9); tone(110, .45, 'square', .03, -20, .1, 6); },
  snore()   { noise(1.1, 280, .07, 0, 'lowpass', 4, .6); tone(70, 1, 'sine', .04, 10, .1); },
  boing()   { tone(220, .22, 'sine', .09, 440); },
  thud()    { tone(110, .15, 'sine', .14, -60); noise(.06, 300, .1, 0, 'lowpass'); },
  burp()    { tone(95, .45, 'sawtooth', .08, -25, 0, 22); },
  wobble()  { tone(300, .9, 'sine', .07, -150, 0, 7); },
  sparkle() { [0, .07, .14, .21, .28].forEach((d, i) => tone(1200 + i * 200, .12, 'sine', .04, 0, d)); },
  cheer()   { tone(523, .12, 'triangle', .07); tone(659, .12, 'triangle', .07, 0, .1); tone(784, .25, 'triangle', .07, 0, .2); },
};
const chime = sfx.chime;

/* ---------------- UI helpers ---------------- */
let speechT = 0;
function say(txt, sec = 2.2) { $('speech').textContent = txt; $('speech').classList.add('show'); speechT = sec; }
function log(txt) { $('log').textContent = txt; }
let toastT = null;
function toast(txt, withFeed = false) {
  $('toastText').textContent = txt; $('toastBtn').style.display = withFeed ? '' : 'none';
  $('toast').classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => $('toast').classList.remove('show'), 6000);
}
let titleBlink = null;
function blinkTitle(on) {
  clearInterval(titleBlink); document.title = 'Zazoo';
  if (on) { let b = 0; titleBlink = setInterval(() => document.title = (b ^= 1) ? '🍪 Zazoo is hungry!' : 'Zazoo', 1000); }
}

/* ---------------- Notifications ---------------- */
function notifSupported() { return 'Notification' in window; }
function refreshNotifBtn() {
  const b = $('btnNotify');
  if (!notifSupported()) { b.textContent = 'Notifications unsupported'; b.disabled = true; return; }
  const p = Notification.permission;
  b.textContent = p === 'granted' ? 'Notifications on' : p === 'denied' ? 'Notifications blocked' : 'Enable notifications';
  b.classList.toggle('on', p === 'granted');
}
async function askNotif() {
  if (!notifSupported()) return;
  try { await Notification.requestPermission(); } catch (e) {}
  refreshNotifBtn();
  if (Notification.permission === 'granted') sendNotif('Notifications are on', "I'll ping you when Zazoo gets hungry.");
}
function sendNotif(title, body) {
  try {
    if (notifSupported() && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: 'zazoo', renotify: true, requireInteraction: false });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch (e) {}
}
function hungryAlert() {
  chime();
  toast('Zazoo is hungry! Give him something to eat.', true);
  sendNotif('Zazoo is hungry! 🍪', 'Your Zazoo wants to eat. Come feed him before he gets grumpy.');
  if (document.hidden) blinkTitle(true);
}

/* ---------------- Actions ---------------- */
function wake(reason) {
  if (!S.asleep) return;
  S.asleep = false; stage.classList.remove('night'); updateButtons();
  if (reason) log(reason);
}
let curFood = 'cookie';
function openTray() { $('tray').classList.add('open'); }
function closeTray() { $('tray').classList.remove('open'); }
function toggleTray() { sfx.click(); $('tray').classList.toggle('open'); }
function feed(kind = 'cookie') {
  if (busy()) return;
  closeTray();
  if (S.asleep) wake('You woke Zazoo up for a snack.');
  const F = FOODS[kind] || FOODS.cookie; curFood = kind;
  const overeat = S.hunger >= CFG.overfullAt;
  S.hunger = Math.min(100, S.hunger + F.food);
  S.happy = Math.min(100, S.happy + F.happy);
  S.hungrySince = null; S.notified = false; blinkTitle(false); $('toast').classList.remove('show');
  S.weight = Math.max(0, Math.min(130, S.weight + F.weight + (overeat ? CFG.weightPerOvereat : 0)));
  play(prefix() + 'eat', { onEnd: () => {
    if (!S.fat && S.weight >= CFG.fatAt) {
      say('Uh oh… too much!'); log('Zazoo ate too much and got fat!'); sfx.wobble();
      play('n_tofat', { onEnd: () => { S.fat = true; toIdle(); sfx.burp(); addPart({ kind: 'text', txt: 'BURP!', x: W * .5, y: W * .25, vy: -30, life: 1.4, col: '#0f7f8c' }); save(); } });
    } else if (overeat) { sfx.burp(); say(S.fat ? 'So… full…' : "I'm full!"); log(S.fat ? 'Careful, he is getting even rounder.' : 'Zazoo is full. Feed him more and he will get fat.'); }
    else { sfx.yum(); say(F.say); log(F.tag === 'healthy' ? `A healthy ${F.name.toLowerCase()}! Weight goes down a little.` : F.tag === 'junk' ? `${F.name}! Tasty, but it makes him heavier.` : `Zazoo enjoyed the ${F.name.toLowerCase()}.`); }
    save();
  } });
}
function buildTray() {
  const t = $('tray');
  Object.entries(FOODS).forEach(([k, F]) => {
    const b = document.createElement('button'); b.className = 'food ' + F.tag;
    const c = document.createElement('canvas'); c.width = c.height = 88;
    drawFood(c.getContext('2d'), k, 44, 46, 30);
    b.append(c, F.name); const sm = document.createElement('small'); sm.textContent = F.tag; b.append(sm);
    b.onclick = () => feed(k); t.append(b);
  });
}
function kiss() {
  if (busy()) return;
  if (S.asleep) wake('Zazoo woke up for a kiss.');
  S.happy = Math.min(100, S.happy + 15);
  play(prefix() + 'kiss', { onEnd: save });
  for (let i = 0; i < 7; i++) setTimeout(() => addPart({ kind: 'heart', x: W * (.3 + Math.random() * .4), y: W * .45, vx: (Math.random() - .5) * 60, vy: -90 - Math.random() * 60, life: 1.8, s: 1.6 + Math.random() }), 900 + i * 160);
  sfx.kiss();
  log('Mwah! Zazoo is blushing.');
}
function toggleSleep() {
  if (busy()) return;
  if (S.asleep) { wake('Good morning, Zazoo!'); toIdle(); say('Morning!'); }
  else { S.asleep = true; stage.classList.add('night'); toIdle(); log('Shh… Zazoo is sleeping.'); }
  updateButtons(); save();
}
let taps = [];
function tapChar(ev) {
  const now = performance.now(); taps = taps.filter(t => now - t < 1300); taps.push(now);
  const r = stage.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W, y = (ev.clientY - r.top) / r.height * W;
  addPart({ kind: 'star', x, y, vy: -50, life: .6, s: 1 });
  if (S.asleep) {
    if (taps.length >= 3) { wake('You woke Zazoo up… he is not happy.'); S.happy = Math.max(0, S.happy - 10); play(prefix() + 'slap', { onEnd: save }); sfx.ouch(); taps = []; }
    else { say('zzz… (tap again to wake)'); sfx.click(); }
    return;
  }
  if (taps.length >= 4 && !(cur && cur.name.endsWith('_slap'))) {
    // poked too much -> annoyed / hurt reaction
    S.happy = Math.max(0, S.happy - 8); taps = [];
    play(prefix() + 'slap', { onEnd: save }); sfx.ouch(); say('Ouch! Stop it!'); log('Too many pokes! Be gentle.'); return;
  }
  if (busy()) return;
  S.happy = Math.min(100, S.happy + 4);
  play(S.fat ? 'f_tap' : 'n_laugh'); S.fat ? sfx.jiggle() : sfx.giggle();
  log(S.fat ? 'Jiggle jiggle!' : 'Hehe, that tickles!');
}
function nag() {
  if (busy() || S.asleep) return;
  play(prefix() + 'shout'); say("I'M HUNGRY!", 2.5); log('Zazoo is angry, he has not eaten in a while!');
  sfx.grumble();
  S.happy = Math.max(0, S.happy - 5);
  sendNotif('Zazoo is getting angry 😠', "He still hasn't eaten. Feed him now!");
}

/* ---------------- Simulation ---------------- */
function simulate(sec) {
  // sec = game seconds elapsed
  S.hunger = Math.max(0, S.hunger - CFG.hungerDecay * sec * (S.asleep ? .5 : 1));
  S.happy = Math.max(0, S.happy - CFG.happyDecay * sec * (S.hunger < CFG.hungryAt ? 2 : 1));
  if (S.asleep) S.energy = Math.min(100, S.energy + CFG.energyGain * sec);
  else S.energy = Math.max(0, S.energy - CFG.energyDecay * sec);
  if (S.weight > 0 && S.hunger < CFG.overfullAt) S.weight = Math.max(0, S.weight - CFG.digest * sec);
}
function brain() {
  // hunger request
  if (S.hunger < CFG.hungryAt) {
    if (S.hungrySince == null) S.hungrySince = gameClock;
    if (!S.notified) { S.notified = true; hungryAlert(); if (!S.asleep && !busy()) say('Feed me?'); }
    if (gameClock - S.hungrySince > CFG.nagAfter && gameClock - S.lastNag > CFG.nagEvery) { S.lastNag = gameClock; nag(); }
  }
  // auto-wake when rested, auto-sleep when exhausted
  if (S.asleep && S.energy >= 100 && !busy()) { wake('Zazoo woke up fully rested.'); toIdle(); say('Morning!'); }
  if (!S.asleep && S.energy < CFG.sleepyAt && !busy()) { S.asleep = true; stage.classList.add('night'); toIdle(); log('Zazoo was so tired he fell asleep.'); updateButtons(); }
  // slim down after digesting
  if (S.fat && S.weight <= CFG.slimAt && !busy() && !S.asleep) {
    log('Zazoo digested everything and is back to normal!');
    S.fat = false; sfx.wobble(); play('n_tofat', { reverse: true, onEnd: () => { say('Light as a feather!'); sfx.sparkle(); } });
  }
  // occasional idle fidget
  if (!S.fat && !S.asleep && !busy() && cur && cur.name === 'n_idle' && cur.f === 0 && Math.random() < .12) play('n_bored', { busy: false });
}

/* ---------------- HUD ---------------- */
function setBar(id, v, colorFn) { $('b' + id).style.width = Math.round(v) + '%'; $('b' + id).style.background = colorFn(v); $('v' + id).textContent = Math.round(v); }
const good = v => v < 25 ? 'var(--red)' : v < 50 ? 'var(--amber)' : 'var(--teal)';
function hud() {
  setBar('Hunger', S.hunger, good); setBar('Energy', S.energy, good); setBar('Happy', S.happy, good);
  const w = Math.min(100, S.weight);
  $('bWeight').style.width = w + '%'; $('bWeight').style.background = S.fat ? 'var(--red)' : w > 60 ? 'var(--amber)' : 'var(--teal)';
  $('vWeight').textContent = S.fat ? 'Fat' : w > 60 ? 'Chubby' : 'Normal';
  const mood = S.asleep ? 'Sleeping' : S.hunger < CFG.hungryAt ? (S.hungrySince != null && gameClock - S.hungrySince > CFG.nagAfter ? 'Angry & hungry' : 'Hungry')
             : S.fat ? 'Stuffed' : S.energy < 30 ? 'Sleepy' : S.happy > 70 ? 'Happy' : 'Okay';
  $('mood').textContent = mood;
}
function updateButtons() {
  $('btnSleep').firstChild.textContent = S.asleep ? 'Wake' : 'Sleep';
  $('btnSleep').querySelector('small').textContent = S.asleep ? 'lights on' : 'lights off';
}

/* ---------------- Loop ---------------- */
let last = performance.now(), brainAcc = 0, saveAcc = 0, snoreAcc = 0;
function frame(now) {
  const dt = Math.min(.1, (now - last) / 1000); last = now;
  const gdt = dt * speed;
  gameClock += gdt; simulate(gdt);
  brainAcc += dt; if (brainAcc > .5) { brainAcc = 0; brain(); hud(); }
  saveAcc += dt; if (saveAcc > 5) { saveAcc = 0; save(); }
  if (speechT > 0) { speechT -= dt; if (speechT <= 0) $('speech').classList.remove('show'); }
  if (S.asleep) { snoreAcc += dt; if (snoreAcc > 3.4) { snoreAcc = 0; sfx.snore(); } } else snoreAcc = 0;
  stepWorkout(dt); stepAnim(dt); drawChar(dt); stepFx(dt);
  requestAnimationFrame(frame);
}

/* ---------------- Boot ---------------- */
// catch up on time passed while the page was closed (capped at 12h)
const away = Math.min(12 * 3600, Math.max(0, (Date.now() - S.t) / 1000));
if (away > 5) simulate(away);
if (S.hunger >= CFG.hungryAt) { S.hungrySince = null; S.notified = false; }
else { S.hungrySince = -CFG.nagAfter * (away > CFG.nagAfter ? 1 : 0); S.notified = false; }
S.lastNag = -999;

stage.addEventListener('pointerdown', tapChar);
buildTray();
$('btnFeed').onclick = toggleTray; $('btnPlay').onclick = exercise;
$('btnKiss').onclick = () => { closeTray(); kiss(); }; $('btnSleep').onclick = () => { closeTray(); toggleSleep(); };
$('toastBtn').onclick = () => { $('toast').classList.remove('show'); openTray(); };
const refreshSound = () => { $('btnSound').textContent = muted ? 'Sound off' : 'Sound on'; $('btnSound').classList.toggle('on', !muted); };
$('btnSound').onclick = () => { muted = !muted; try { localStorage.setItem('zazoo-muted', muted ? '1' : '0'); } catch (e) {} refreshSound(); sfx.click(); };
refreshSound();
$('btnNotify').onclick = askNotif;
$('btnSpeed').onclick = () => { speed = speed === 1 ? 10 : speed === 10 ? 60 : 1; $('btnSpeed').textContent = 'Time ×' + speed; $('btnSpeed').classList.toggle('on', speed > 1); };
$('btnReset').onclick = () => { workout = null; S = fresh(); S.lastNag = -999; gameClock = 0; stage.classList.remove('night'); updateButtons(); toIdle(); save(); log('New Zazoo!'); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) blinkTitle(false); });
refreshNotifBtn();
// Notifications ON by default: ask right away, and again on the first tap/click
// (most browsers only show the permission prompt after a user gesture).
function autoNotif() {
  if (!notifSupported() || Notification.permission !== 'default') return;
  try { const r = Notification.requestPermission(); if (r && r.then) r.then(refreshNotifBtn); } catch (e) {}
}
autoNotif();
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, function once() {
  autoNotif(); document.removeEventListener(ev, once, true);
}, true));

loadAll().then(() => {
  $('loading').remove();
  if (S.asleep) stage.classList.add('night');
  updateButtons(); toIdle(); hud();
  say(S.hunger < CFG.hungryAt ? 'Feed me?' : 'Hi!');
  requestAnimationFrame(t => { last = t; frame(t); });
}).catch(k => { $('loading').textContent = 'Could not load the animations. Keep index.html next to the sprites folder.'; });

// expose for quick testing in the console
window.zazoo = { S: () => S, CFG, feed, kiss, nag, toggleSleep, exercise, sfx };
})();
