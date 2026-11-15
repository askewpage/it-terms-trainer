'use strict';
/* IT-словарь: тренажёр терминов. Статичный сайт, прогресс в localStorage. */

const LS_KEY = 'it-terms-trainer-v1';
const EXAM_SIZE = 20;
const EXAM_ALL_SIZE = 40;
const QUICK_SIZE = 10;
const PASS = 0.8;
const KINDS = {
  def:  { name: 'Что означает', d: 'термин → смысл' },
  term: { name: 'Как называется', d: 'смысл → термин' },
  abbr: { name: 'Расшифровка', d: 'аббревиатура → полное название' },
  prac: { name: 'Практика', d: 'вопросы на понимание' },
};

let TOPICS = [];    // [{id, name, icon, sections:[name]}]
let TERMS = [];     // [{id, topic, section, t, full, def}]
let Q = {};         // key -> question
let KEYS = [];
let S = loadState();
let cur = null;     // текущая сессия
let view = null;    // 'glossary' | null
let _open = null;   // раскрытые темы на главной
const app = document.getElementById('app');

/* ---------- storage ---------- */
function emptyState() { return { stats: {}, mistakes: {}, exams: [], marathon: {}, current: null }; }
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.stats) return Object.assign(emptyState(), s);
  } catch (e) {}
  return emptyState();
}
function save() {
  if (cur && !cur.finished) {
    if (cur.marathonKey) S.marathon[cur.marathonKey] = cur;
    else S.current = cur;
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {}
}

/* ---------- utils ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plural = (n, f) => f[(n % 100 > 4 && n % 100 < 20) ? 2 : [2, 0, 1, 1, 1, 2][Math.min(n % 10, 5)]];
const qWord = n => n + ' ' + plural(n, ['вопрос', 'вопроса', 'вопросов']);
const tWord = n => n + ' ' + plural(n, ['термин', 'термина', 'терминов']);
const fmtDate = t => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const topicById = id => TOPICS.find(t => t.id === id);
const topicName = id => id === 'all' ? 'Все темы' : (topicById(id) || { name: id }).name;
const learned = k => S.stats[k] && S.stats[k].last === 1;
const pct = ks => ks.length ? Math.round(ks.filter(learned).length / ks.length * 100) : 0;
const keysWhere = f => KEYS.filter(k => f(Q[k]));
const slug = s => s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '');
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function seededShuffle(a, seed) { const r = rng(seed); a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = r() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

/* ---------- build question bank ---------- */
function parseTerms() {
  for (const tp of window.TERMS) {
    const secs = [];
    for (const [sec, text] of Object.entries(tp.sections)) {
      secs.push(sec);
      for (const line of text.split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        const p = l.split('|').map(x => x.trim());
        if (p.length < 3) { console.warn('bad line', l); continue; }
        const full = p[1] === '-' ? '' : p[1];
        TERMS.push({ id: tp.id + ':' + slug(p[0]), topic: tp.id, section: sec, t: p[0], full, def: p.slice(2).join(' | ') });
      }
    }
    TOPICS.push({ id: tp.id, name: tp.name, icon: tp.icon || '', sections: secs });
  }
}

// убрать сам термин из определения, чтобы не подсказывать
function maskDef(term) {
  let d = term.def;
  const parts = term.t.split(/\s*\/\s*|\s+vs\s+/).concat(term.full ? [term.full] : []).filter(x => x.length > 1);
  for (const p of parts) {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    d = d.replace(re, '…');
  }
  return d;
}

function pickDistractors(term, pool, field, seed, n = 3) {
  const val = x => field === 'def' ? x.def : field === 'full' ? x.full : x.t;
  const mine = val(term).toLowerCase();
  const sameSec = pool.filter(x => x !== term && x.section === term.section);
  const sameTopic = pool.filter(x => x !== term && x.topic === term.topic && x.section !== term.section);
  const other = pool.filter(x => x.topic !== term.topic);
  const out = [], seen = new Set([mine]);
  for (const group of [sameSec, sameTopic, other]) {
    for (const x of seededShuffle(group, seed++)) {
      const v = val(x); if (!v || seen.has(v.toLowerCase())) continue;
      seen.add(v.toLowerCase()); out.push(v);
      if (out.length >= n) return out;
    }
  }
  return out;
}

function addQ(q) { Q[q.key] = q; KEYS.push(q.key); }

function buildBank() {
  parseTerms();
  const withFull = TERMS.filter(t => t.full && t.full.toLowerCase() !== t.t.toLowerCase());
  for (const t of TERMS) {
    const base = { topic: t.topic, section: t.section, term: t, multi: false, ok: [0] };
    let k = t.id + ':def';
    addQ(Object.assign({ key: k, kind: 'def', q: `Что означает «${t.t}»?`, a: [t.def, ...pickDistractors(t, TERMS, 'def', hash(k))] }, base));
    k = t.id + ':term';
    addQ(Object.assign({ key: k, kind: 'term', q: `Как это называется: ${maskDef(t)}`, a: [t.t, ...pickDistractors(t, TERMS, 'term', hash(k))] }, base));
    if (withFull.includes(t)) {
      k = t.id + ':abbr';
      addQ(Object.assign({ key: k, kind: 'abbr', q: `Как расшифровывается «${t.t}»?`, a: [t.full, ...pickDistractors(t, withFull, 'full', hash(k))] }, base));
    }
  }
  for (const c of window.QUESTIONS || []) {
    const key = c.topic + ':q:' + hash(c.q).toString(36);
    const ok = c.ok || [0];
    addQ({ key, kind: 'prac', topic: c.topic, section: c.s || 'Практика', q: c.q, a: c.a, ok, multi: ok.length > 1, ex: c.ex });
    const tp = topicById(c.topic);
    if (tp && !tp.sections.includes(c.s)) tp.sections.push(c.s);
  }
}

/* ---------- init (вызывается в конце файла) ---------- */
function boot() { try {
  buildBank();
  if (S.current && !S.current.keys.every(k => Q[k])) S.current = null;
  for (const m in S.marathon) if (!S.marathon[m].keys.every(k => Q[k])) delete S.marathon[m];
  for (const k in S.mistakes) if (!Q[k]) delete S.mistakes[k];
  window.addEventListener('popstate', () => { if (cur) save(); cur = null; view = null; home(); });
  home();
} catch (e) {
  app.innerHTML = '<p class="empty">Не удалось загрузить базу: ' + esc(e.message) + '</p>';
  console.error(e);
} }

/* ---------- home ---------- */
function tile({ t, d, act, primary, bar, disabled }) {
  return `<button class="card tile${primary ? ' primary' : ''}" data-act="${esc(act)}"${disabled ? ' disabled' : ''}>
    <span class="t">${t}</span><span class="d">${d}</span>${bar != null ? `<span class="bar"><i style="width:${bar}%"></i></span>` : ''}</button>`;
}
const marTile = (mk, label, total) => {
  const m = S.marathon[mk], done = m ? Object.keys(m.answers).length : 0;
  return tile({ t: label, d: m ? `продолжить · ${done} из ${m.keys.length}` : 'все ' + qWord(total) + ' подряд', act: 'mar:' + mk.slice(2), bar: m ? Math.round(done / m.keys.length * 100) : null });
};

function home() {
  cur = null; view = null;
  document.title = 'IT-словарь · тренажёр';
  const mistakes = Object.keys(S.mistakes);
  const last7 = S.exams.slice(-7);
  let h = `<header class="hero"><h1>IT-словарь</h1>
    <p class="sub">${tWord(TERMS.length)} · ${qWord(KEYS.length)} · изучено ${pct(KEYS)}%</p>
    <div class="bar big-bar"><i style="width:${pct(KEYS)}%"></i></div></header>`;

  if (S.current) {
    const c = S.current, done = Object.keys(c.answers).length;
    h += `<div class="grid one">${tile({ t: 'Продолжить: ' + esc(c.title), d: `${done} из ${c.keys.length}`, act: 'resume', primary: true, bar: Math.round(done / c.keys.length * 100) })}</div>`;
  }

  h += `<div class="grid">
    ${tile({ t: '⚡ Разминка', d: `${QUICK_SIZE} случайных · сначала слабые`, act: 'quick:all', primary: true })}
    ${tile({ t: 'Экзамен-микс', d: `${EXAM_ALL_SIZE} по всем темам · от ${PASS * 100}%`, act: 'exam:all' })}
    ${tile({ t: 'Работа над ошибками', d: mistakes.length ? qWord(mistakes.length) : 'ошибок нет', act: 'err:all', disabled: !mistakes.length })}
    ${tile({ t: '📖 Глоссарий', d: 'все термины с поиском', act: 'gloss:all' })}
  </div>`;

  h += `<h2>Темы</h2>`;
  for (const t of TOPICS) {
    const tk = keysWhere(q => q.topic === t.id);
    const tm = mistakes.filter(k => Q[k].topic === t.id);
    const nTerms = TERMS.filter(x => x.topic === t.id).length;
    const kinds = Object.keys(KINDS).map(kd => ({ kd, keys: tk.filter(k => Q[k].kind === kd) })).filter(x => x.keys.length);
    const secs = t.sections.map(s => ({ s, keys: tk.filter(k => Q[k].section === s) })).filter(x => x.keys.length);
    const p = pct(tk);
    h += `<details class="card topic" data-topic="${t.id}"${openTopics().has(t.id) ? ' open' : ''}>
      <summary class="topic-head">
        <span class="ic">${t.icon}</span>
        <span class="nm"><b>${esc(t.name)}</b><span class="d">${tWord(nTerms)} · ${qWord(tk.length)}</span></span>
        <span class="pc">${p}%</span>
        <span class="bar"><i style="width:${p}%"></i></span>
      </summary>
      <div class="topic-body">
      <div class="grid">
        ${tile({ t: 'Экзамен', d: `${EXAM_SIZE} случайных · от ${PASS * 100}%`, act: 'exam:' + t.id, primary: true })}
        ${marTile('m:' + t.id, 'Марафон', tk.length)}
        ${tile({ t: 'Ещё не решённые', d: qWord(tk.filter(k => !learned(k)).length), act: 'new:' + t.id, disabled: tk.every(learned) })}
        ${tile({ t: 'Ошибки', d: tm.length ? qWord(tm.length) : 'ошибок нет', act: 'err:' + t.id, disabled: !tm.length })}
      </div>
      <div class="chips">${kinds.map(x => `<button class="chip" data-act="kind:${t.id}:${x.kd}">${KINDS[x.kd].name} <span>${pct(x.keys)}% · ${x.keys.length}</span></button>`).join('')}
        <button class="chip ghost" data-act="gloss:${t.id}">📖 Глоссарий темы</button></div>
      <div class="sec-list">
        ${secs.map(x => `<button class="sec" data-act="sec:${t.id}:${esc(x.s)}">
          <span class="n">${esc(x.s)}</span><span class="c">${pct(x.keys)}% · ${x.keys.length}</span></button>`).join('')}
      </div></div>
    </details>`;
  }

  if (S.exams.length) {
    h += `<h2>История экзаменов</h2><div class="card history">` + S.exams.slice(-15).reverse().map(e =>
      `<div class="row"><span>${esc(topicName(e.topic))} · ${fmtDate(e.t)}</span><span>${e.r}/${e.n} <span class="pill ${e.ok ? 'ok' : 'bad'}">${e.ok ? 'сдал' : 'не сдал'}</span></span></div>`).join('') + `</div>`;
  }
  h += `<div class="foot"><button class="link danger" data-act="reset">Сбросить весь прогресс</button></div>`;
  app.innerHTML = h;
  app.querySelectorAll('[data-act]').forEach(b => b.onclick = e => { e.preventDefault(); homeAction(b.dataset.act); });
  app.querySelectorAll('details.topic').forEach(d => d.ontoggle = () => {
    const s = openTopics(); d.open ? s.add(d.dataset.topic) : s.delete(d.dataset.topic);
    try { localStorage.setItem(LS_KEY + ':open', JSON.stringify([...s])); } catch (e) {}
  });
  window.scrollTo(0, 0);
}
function openTopics() {
  if (!_open) { try { _open = new Set(JSON.parse(localStorage.getItem(LS_KEY + ':open')) || []); } catch (e) { _open = new Set(); } }
  return _open;
}

// для разминки: сначала ошибки и не решённые
function weakFirst(keys, n) {
  const w = k => S.mistakes[k] ? 0 : !S.stats[k] ? 1 : learned(k) ? 3 : 2;
  return shuffle(keys).sort((a, b) => w(a) - w(b)).slice(0, n);
}

function homeAction(act) {
  const parts = act.split(':'), a = parts[0], t = parts[1], rest = parts.slice(2).join(':');
  const byTopic = q => t === 'all' || q.topic === t;
  if (a === 'resume') return open(S.current);
  if (a === 'gloss') return glossary(t);
  if (a === 'quick') return start({ title: 'Разминка', mode: 'train', keys: shuffle(weakFirst(keysWhere(byTopic), QUICK_SIZE)) });
  if (a === 'exam') {
    const keys = examKeys(t);
    return start({ title: 'Экзамен · ' + topicName(t), mode: 'exam', keys, topic: t });
  }
  if (a === 'kind') return start({ title: `${topicName(t)} · ${KINDS[rest].name}`, mode: 'train', keys: shuffle(keysWhere(q => q.topic === t && q.kind === rest)) });
  if (a === 'sec') return start({ title: rest, mode: 'train', keys: shuffle(keysWhere(q => q.topic === t && q.section === rest)) });
  if (a === 'new') return start({ title: topicName(t) + ' · не решённые', mode: 'train', keys: shuffle(keysWhere(q => q.topic === t && !learned(q.key))) });
  if (a === 'err') return start({ title: 'Ошибки' + (t === 'all' ? '' : ' · ' + topicName(t)), mode: 'train', keys: shuffle(Object.keys(S.mistakes).filter(k => byTopic(Q[k]))) });
  if (a === 'mar') {
    const mk = 'm:' + t;
    if (S.marathon[mk]) return open(S.marathon[mk]);
    return start({ title: 'Марафон · ' + topicName(t), mode: 'train', marathonKey: mk, keys: shuffle(keysWhere(byTopic)) });
  }
  if (a === 'reset') {
    if (confirm('Удалить всю статистику, ошибки, историю экзаменов и сохранённые марафоны?')) { S = emptyState(); save(); home(); }
  }
}

// экзамен: не больше одного вопроса на термин, чтобы не было подсказок
function examKeys(t) {
  const size = t === 'all' ? EXAM_ALL_SIZE : EXAM_SIZE;
  const used = new Set(), out = [];
  for (const k of shuffle(keysWhere(q => t === 'all' || q.topic === t))) {
    const id = Q[k].term ? Q[k].term.id : k;
    if (used.has(id)) continue;
    used.add(id); out.push(k);
    if (out.length >= size) break;
  }
  return out;
}

/* ---------- glossary ---------- */
function glossary(topic, query) {
  view = 'glossary'; cur = null;
  if (!history.state || !history.state.view) history.pushState({ view: 1 }, '');
  document.title = 'Глоссарий · IT-словарь';
  const tabs = [{ id: 'all', name: 'Все' }].concat(TOPICS);
  app.innerHTML = `
    <div class="top"><div class="top-row"><button class="icon-btn" data-g="home" title="На главную">←</button>
      <div class="title">Глоссарий</div><div class="counter" id="gcount"></div></div>
      <input class="search" id="gq" type="search" placeholder="Поиск: RLS, джойн, токен…" value="${esc(query || '')}" autocomplete="off">
      <div class="tabs">${tabs.map(x => `<button class="tab${x.id === topic ? ' on' : ''}" data-tab="${x.id}">${x.icon ? x.icon + ' ' : ''}${esc(x.name)}</button>`).join('')}</div>
    </div>
    <div id="glist"></div>`;
  const inp = document.getElementById('gq');
  const draw = () => {
    const qv = inp.value.trim().toLowerCase();
    const list = TERMS.filter(x => (topic === 'all' || x.topic === topic) &&
      (!qv || (x.t + ' ' + x.full + ' ' + x.def).toLowerCase().includes(qv)));
    document.getElementById('gcount').textContent = list.length;
    let h = '', lastSec = '';
    for (const x of list) {
      const sec = (topic === 'all' ? topicName(x.topic) + ' · ' : '') + x.section;
      if (sec !== lastSec) { h += `<h3 class="gsec">${esc(sec)}</h3>`; lastSec = sec; }
      const st = [x.id + ':def', x.id + ':term', x.id + ':abbr'].filter(k => Q[k]);
      const mark = st.some(k => S.mistakes[k]) ? 'bad' : st.every(learned) ? 'ok' : '';
      h += `<div class="card gitem ${mark}"><div class="gt">${esc(x.t)}${x.full ? `<span class="gf">${esc(x.full)}</span>` : ''}</div><div class="gd">${esc(x.def)}</div></div>`;
    }
    document.getElementById('glist').innerHTML = h || '<p class="empty">Ничего не найдено</p>';
  };
  inp.oninput = draw;
  draw();
  app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { glossary(b.dataset.tab, inp.value); });
  app.querySelector('[data-g="home"]').onclick = () => { if (history.state && history.state.view) history.back(); else home(); };
  if (!('ontouchstart' in window)) inp.focus();
}

/* ---------- session ---------- */
function start(o) {
  if (!o.keys.length) return;
  const s = Object.assign({ i: 0, answers: {}, orders: {}, sel: {}, finished: false, started: Date.now() }, o);
  for (const k of s.keys) s.orders[k] = shuffle(Q[k].a.map((_, i) => i));
  if (!s.marathonKey) S.current = null;
  open(s);
}
function open(s) {
  cur = s; view = null;
  history.pushState({ quiz: 1 }, '');
  save();
  renderQ();
}
function leave() {
  save(); cur = null;
  if (history.state && history.state.quiz) history.back(); else home();
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

function submit(i, sel) {
  const k = cur.keys[i], q = Q[k];
  const ok = sameSet(sel, q.ok);
  cur.answers[i] = { sel, ok };
  if (cur.mode === 'train') record(k, ok);
  save();
}
function record(k, ok) {
  const st = S.stats[k] || (S.stats[k] = { r: 0, w: 0, last: 0 });
  if (ok) st.r++; else st.w++;
  st.last = ok ? 1 : 0;
  if (ok) delete S.mistakes[k]; else S.mistakes[k] = Date.now();
}

function explain(q) {
  if (q.term) {
    const t = q.term;
    return `<div class="explain"><div class="et">${esc(t.t)}${t.full ? ` <span>— ${esc(t.full)}</span>` : ''}</div><div>${esc(t.def)}</div></div>`;
  }
  return q.ex ? `<div class="explain"><div>${esc(q.ex)}</div></div>` : '';
}

/* ---------- question view ---------- */
function renderQ() {
  const s = cur, i = s.i, k = s.keys[i], q = Q[k];
  const ans = s.answers[i];
  const exam = s.mode === 'exam';
  const revealed = !exam && ans;
  const sel = ans ? ans.sel : (s.sel[i] || []);
  const order = s.orders[k];
  document.title = `${i + 1}/${s.keys.length} · ${s.title}`;

  const strip = s.keys.map((_, j) => {
    const a = s.answers[j];
    const cls = !a ? '' : exam ? 'done' : a.ok ? 'ok' : 'bad';
    return `<button data-go="${j}" class="${cls}${j === i ? ' cur' : ''}">${j + 1}</button>`;
  }).join('');

  const termAnswers = q.kind === 'term';
  const opts = order.map((ai, n) => {
    let cls = 'opt' + (q.multi ? ' multi' : '') + (termAnswers ? ' mono' : '');
    const isSel = sel.includes(ai), isOk = q.ok.includes(ai);
    if (revealed) cls += isOk && isSel ? ' right' : isSel ? ' wrong' : isOk ? (q.multi ? ' missed' : ' right') : '';
    else if (isSel) cls += ' sel';
    const mark = revealed ? (isOk ? '✓' : isSel ? '✗' : n + 1) : (q.multi && isSel ? '✓' : n + 1);
    return `<button class="${cls}" data-opt="${ai}"${revealed ? ' disabled' : ''}><span class="k">${mark}</span><span class="tx">${esc(q.a[ai])}</span></button>`;
  }).join('');

  const answeredCount = Object.keys(s.answers).length;
  const last = i === s.keys.length - 1;
  let verdict = '';
  if (revealed) verdict = (ans.ok ? `<div class="verdict ok">Верно</div>` : `<div class="verdict bad">Неверно${q.multi ? ' — правильные варианты отмечены зелёным' : ''}</div>`) + explain(q);

  let buttons;
  if (exam) {
    const needSubmit = q.multi && !ans;
    buttons = `<button class="btn small" data-nav="prev"${i === 0 ? ' disabled' : ''}>←</button>`
      + (needSubmit ? `<button class="btn main" data-nav="submit"${sel.length ? '' : ' disabled'}>Ответить</button>`
        : `<button class="btn main" data-nav="next">${last ? 'Завершить' : 'Далее'}</button>`)
      + (last ? '' : `<button class="btn small" data-nav="finish">Завершить</button>`);
  } else if (!ans) {
    buttons = q.multi ? `<button class="btn main" data-nav="submit"${sel.length ? '' : ' disabled'}>Ответить</button>`
      : `<button class="btn" data-nav="skip">Пропустить</button>`;
  } else {
    buttons = `<button class="btn main" data-nav="next">${answeredCount === s.keys.length ? 'Результат' : 'Далее'}</button>`;
  }

  app.innerHTML = `
    <div class="top">
      <div class="top-row"><button class="icon-btn" data-nav="home" title="На главную">←</button>
        <div class="title">${esc(s.title)}</div><div class="counter">${i + 1} / ${s.keys.length}</div></div>
      <div class="strip">${strip}</div>
    </div>
    <div class="card qcard">
      <div class="meta"><span>${esc(topicName(q.topic))}</span><span class="lvl">${KINDS[q.kind].name}</span><span>${esc(q.section)}</span></div>
      <p class="qtext">${esc(q.q)}</p>
      ${q.multi ? '<p class="hint">Несколько правильных ответов</p>' : ''}
      <div class="opts">${opts}</div>
      ${verdict}
    </div>
    <p class="kbd">Клавиши: 1–9 — выбор, Enter — ответить / далее, ← → — навигация</p>
    <div class="actions"><div class="in">${buttons}</div></div>`;

  const cb = app.querySelector('.strip .cur');
  if (cb) cb.scrollIntoView({ block: 'nearest', inline: 'center' });
  app.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(+b.dataset.go));
  app.querySelectorAll('[data-opt]').forEach(b => b.onclick = () => pick(+b.dataset.opt));
  app.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => nav(b.dataset.nav));
}

function pick(ai) {
  const s = cur, i = s.i, q = Q[s.keys[i]];
  const exam = s.mode === 'exam';
  if (!exam && s.answers[i]) return;
  if (q.multi) {
    if (exam && s.answers[i]) { s.sel[i] = s.answers[i].sel.slice(); delete s.answers[i]; }
    const sel = s.sel[i] = (s.sel[i] || []).slice();
    const p = sel.indexOf(ai); if (p >= 0) sel.splice(p, 1); else sel.push(ai);
    save(); renderQ();
  } else {
    submit(i, [ai]);
    renderQ();
    if (exam) setTimeout(() => { if (cur === s && s.i === i) nextUnanswered(); }, 220);
  }
}

function go(j) { cur.i = Math.max(0, Math.min(cur.keys.length - 1, j)); save(); renderQ(); window.scrollTo(0, 0); }

function nextUnanswered() {
  const s = cur, n = s.keys.length;
  for (let d = 1; d <= n; d++) { const j = (s.i + d) % n; if (!s.answers[j]) return go(j); }
  if (s.mode === 'exam') return go(s.i < n - 1 ? s.i + 1 : s.i);
  finish();
}

function nav(a) {
  const s = cur;
  if (a === 'home') return leave();
  if (a === 'prev') return go(s.i - 1);
  if (a === 'submit') { const sel = s.sel[s.i] || []; if (!sel.length) return; submit(s.i, sel); return s.mode === 'exam' ? nextUnanswered() : renderQ(); }
  if (a === 'skip') return nextUnanswered();
  if (a === 'finish') return confirmFinish();
  if (a === 'next') {
    if (s.mode === 'exam') return s.i === s.keys.length - 1 ? confirmFinish() : go(s.i + 1);
    return nextUnanswered();
  }
}

function confirmFinish() {
  const left = cur.keys.length - Object.keys(cur.answers).length;
  if (left && !confirm(`Без ответа: ${qWord(left)}. Они будут засчитаны как ошибки. Завершить экзамен?`)) return;
  finish();
}

/* ---------- result ---------- */
function finish() {
  const s = cur;
  s.finished = true;
  const n = s.keys.length;
  if (s.mode === 'exam') s.keys.forEach((k, j) => record(k, !!(s.answers[j] && s.answers[j].ok)));
  const right = s.keys.filter((_, j) => s.answers[j] && s.answers[j].ok).length;
  const passed = right / n >= PASS;
  if (s.mode === 'exam') S.exams.push({ topic: s.topic, t: Date.now(), r: right, n, ok: passed });
  if (s.marathonKey) delete S.marathon[s.marathonKey]; else S.current = null;
  save();
  renderResult(s, right, passed);
}

function renderResult(s, right, passed) {
  const n = s.keys.length, exam = s.mode === 'exam';
  const wrongIdx = s.keys.map((_, j) => j).filter(j => !(s.answers[j] && s.answers[j].ok));
  const need = Math.ceil(n * PASS);
  document.title = 'Результат · ' + s.title;
  const review = wrongIdx.map(j => {
    const q = Q[s.keys[j]], a = s.answers[j];
    const sel = a ? a.sel : [];
    return `<div class="card"><div class="q">${j + 1}. ${esc(q.q)}</div>
      ${s.orders[q.key].filter(ai => q.ok.includes(ai) || sel.includes(ai)).map(ai =>
        `<div class="a ${q.ok.includes(ai) ? 'right' : 'wrong'}">${esc(q.a[ai])}</div>`).join('')}
      ${!a ? '<div class="a wrong">нет ответа</div>' : ''}${explain(q)}</div>`;
  }).join('');

  app.innerHTML = `
    <div class="top"><div class="top-row"><button class="icon-btn" data-r="home">←</button><div class="title">${esc(s.title)}</div></div></div>
    <div class="card result">
      ${exam ? `<div class="status ${passed ? 'ok' : 'bad'}">${passed ? 'Экзамен сдан' : 'Экзамен не сдан'}</div>` : '<div class="status">Готово</div>'}
      <div class="big">${right} / ${n}</div>
      <div class="sub" style="margin:0">${Math.round(right / n * 100)}%${exam ? ` · нужно ${need} правильных (${PASS * 100}%)` : ''} · ошибок: ${wrongIdx.length}</div>
    </div>
    ${wrongIdx.length ? `<h2>Разбор ошибок</h2><div class="review">${review}</div>` : '<p class="empty">Без ошибок 🎉</p>'}
    <div class="actions"><div class="in">
      ${wrongIdx.length ? '<button class="btn" data-r="errors">Прорешать ошибки</button>' : ''}
      <button class="btn main" data-r="again">${exam ? 'Новый билет' : 'Заново'}</button>
    </div></div>`;
  app.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    const r = b.dataset.r;
    if (r === 'home') { cur = null; if (history.state && history.state.quiz) history.back(); else home(); return; }
    history.replaceState(null, '');
    if (r === 'errors') return start({ title: 'Ошибки · ' + s.title, mode: 'train', keys: shuffle(wrongIdx.map(j => s.keys[j])) });
    if (exam) return start({ title: s.title, mode: 'exam', topic: s.topic, keys: examKeys(s.topic) });
    start({ title: s.title, mode: 'train', marathonKey: s.marathonKey, keys: shuffle(s.keys) });
  });
  window.scrollTo(0, 0);
}

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  if (!cur || cur.finished || e.metaKey || e.ctrlKey || e.altKey) return;
  const q = Q[cur.keys[cur.i]];
  if (/^[1-9]$/.test(e.key)) {
    const ai = cur.orders[q.key][+e.key - 1];
    if (ai != null) pick(ai);
  } else if (e.key === 'Enter') {
    const b = app.querySelector('.actions .btn.main:not([disabled])') || app.querySelector('[data-nav="skip"]');
    if (b) { e.preventDefault(); b.click(); }
  } else if (e.key === 'ArrowRight') go(cur.i + 1);
  else if (e.key === 'ArrowLeft') go(cur.i - 1);
});

boot();
