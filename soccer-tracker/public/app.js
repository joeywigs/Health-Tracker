/* soccer.hminv.com — live match tracker
 *
 * Design rules this file follows:
 *  - The phone is the source of truth mid-game. Every mutation writes to
 *    localStorage synchronously, then queues an idempotent upsert for D1.
 *    Losing signal on the sideline costs nothing.
 *  - The clock is derived from a wall-clock timestamp, never accumulated ticks,
 *    so backgrounding the tab or locking the phone cannot make it drift.
 *  - Every logged event is undoable and editable. You will mistap.
 */
'use strict';

/* ═══════════════════════════════════════════════════════════ constants ══ */

const LS = {
  teams:    'st.teams.v1',
  players:  'st.players.v1',
  game:     'st.game.v1',
  history:  'st.history.v1',
  outbox:   'st.outbox.v1',
};

/* Event types are the vocabulary stored in D1 — labels, and which of them
 * count toward the score. Buttons are a separate concern below, because one
 * button can now produce more than one event. */
const EVENT_TYPES = [
  { type: 'goal',      label: 'Goal',          assist: true },
  { type: 'shot_on',   label: 'Shot on goal' },
  { type: 'shot_off',  label: 'Shot off' },
  { type: 'save',      label: 'Goalie save' },
  { type: 'corner',    label: 'Corner kick' },
  { type: 'goal_kick', label: 'Goal kick' },
  { type: 'throw_in',  label: 'Throw in' },
  { type: 'free_kick', label: 'Free kick' },
  { type: 'foul',      label: 'Foul' },
  { type: 'offside',   label: 'Offside' },
  { type: 'block',     label: 'Block / clear' },
  { type: 'tackle',    label: 'Tackle won' },
  { type: 'pk_scored', label: 'PK scored' },
  { type: 'pk_missed', label: 'PK missed' },
  { type: 'yellow',    label: 'Yellow card' },
  { type: 'red',       label: 'Red card' },
  { type: 'injury',    label: 'Injury' },
  { type: 'sub',       label: 'Substitution',  usOnly: true },
  { type: 'keeper_in', label: 'Keeper change', usOnly: true },
];

/* The in-game grid. tier 1 is always visible; tier 2 sits behind "More…".
 *
 * "Shot" is one button covering the whole sequence — shooter, then outcome —
 * because that is how a shot actually unfolds while you are watching it. It
 * replaces the separate Goal / Shot on goal / Goalie save buttons:
 *
 *   Shot → who? → Saved       logs a shot on goal for the shooter
 *                             and a save for the other team's keeper
 *               → Goal        logs the goal, then asks for an assist
 *               → Deflected   logs a shot on goal, a save for the keeper,
 *                             and a corner kick back to the shooting team
 *               → Out         logs a shot off target for the shooter
 *                             and a goal kick to the other team
 *
 * `counts` is what the badge on the button adds up. Goal and Goalie save stay
 * available under "More…" for when you only caught the tail of a play.
 */
const BUTTONS = [
  { key: 'shot', label: 'Shot', tier: 1, flow: 'shot', cls: 'goal',
    counts: ['goal', 'shot_on', 'shot_off', 'pk_scored', 'pk_missed'] },
  { key: 'throw_in',  type: 'throw_in',  tier: 1, primary: true },
  { key: 'corner',    type: 'corner',    tier: 1 },
  { key: 'goal_kick', type: 'goal_kick', tier: 1 },
  { key: 'offside',   type: 'offside',   tier: 1 },
  { key: 'free_kick', type: 'free_kick', tier: 1 },

  { key: 'save',      type: 'save',      tier: 2, prompt: 'keeper', label: 'Goalie save (manual)' },
  { key: 'goal',      type: 'goal',      tier: 2, label: 'Goal (manual)' },
  { key: 'foul',      type: 'foul',      tier: 2 },
  { key: 'block',     type: 'block',     tier: 2 },
  { key: 'tackle',    type: 'tackle',    tier: 2 },
  { key: 'pk_scored', type: 'pk_scored', tier: 2 },
  { key: 'pk_missed', type: 'pk_missed', tier: 2 },
  { key: 'yellow',    type: 'yellow',    tier: 2 },
  { key: 'red',       type: 'red',       tier: 2 },
  { key: 'injury',    type: 'injury',    tier: 2 },
  // Substitution (which now carries the keeper change) lives in the scoreboard,
  // not the stat columns — it is about the team, not about a moment of play.
];

const TYPE_MAP = Object.fromEntries(EVENT_TYPES.map((t) => [t.type, t]));
const BUTTON_MAP = Object.fromEntries(BUTTONS.map((b) => [b.key, b]));
const btnLabel = (b) => b.label ?? TYPE_MAP[b.type]?.label ?? b.key;
const btnCounts = (b) => b.counts ?? [b.type];
const SCORING = new Set(['goal', 'pk_scored']);
const MARKERS = { half_time: 'Halftime', full_time: 'Full time', kickoff: 'Kickoff', second_half: '2nd half kickoff' };

const DEFAULT_TEAMS = [
  { id: 'grey',   label: 'Grey',   club_name: '', half_length_min: 25, color: '#38bdf8', updated_at: 0 },
  { id: 'sloane', label: 'Sloane', club_name: '', half_length_min: 25, color: '#f472b6', updated_at: 0 },
];

/* ══════════════════════════════════════════════════════════════ state ══ */

const state = {
  teams: [],
  players: [],
  game: null,
  history: [],
  outbox: { teams: {}, players: {}, games: {}, events: {} },
  setup: null,
  viewingGame: null,
  screen: 'home',
};

let tickTimer = null;
let syncTimer = null;
let wakeLock = null;

/* ══════════════════════════════════════════════════════════════ utils ══ */

const $ = (sel) => document.querySelector(sel);
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('localStorage write failed', err);
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function mmss(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function buzz(ms = 12) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 1900);
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ═════════════════════════════════════════════════════════════ storage ══ */

function hydrate() {
  state.teams = load(LS.teams, null) || DEFAULT_TEAMS.map((t) => ({ ...t }));
  state.players = load(LS.players, []);
  state.game = load(LS.game, null);
  state.history = load(LS.history, []);
  state.outbox = load(LS.outbox, { teams: {}, players: {}, games: {}, events: {} });
  for (const k of ['teams', 'players', 'games', 'events']) state.outbox[k] ||= {};
}

function persistGame() {
  if (state.game) {
    state.game.updated_at = Date.now();
    save(LS.game, state.game);
    queue('games', gameForServer(state.game));
  } else {
    localStorage.removeItem(LS.game);
  }
}

function persistRoster() {
  save(LS.teams, state.teams);
  save(LS.players, state.players);
}

function queue(bucket, record) {
  if (!record || !record.id) return;
  state.outbox[bucket][record.id] = record;
  save(LS.outbox, state.outbox);
  scheduleSync();
}

/* ══════════════════════════════════════════════════════════════ teams ══ */

const teamById = (id) => state.teams.find((t) => t.id === id);
const playersOf = (teamId) =>
  state.players
    .filter((p) => p.team_id === teamId && p.active !== 0 && p.active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.number ?? 999) - (b.number ?? 999));
const playerById = (id) => state.players.find((p) => p.id === id);

/**
 * Stats key on a roster id when we have one, and on the jersey number when the
 * player was typed in — a guest, a call-up, or someone we only saw the number
 * of. `#12` is a perfectly good thing to attribute a goal to.
 */
const whoKey = (playerId, number) =>
  playerId || (number != null ? `#${number}` : null);

const whoLabel = (key) =>
  (typeof key === 'string' && key.startsWith('#')) ? key : playerLabel(key);

function playerLabel(id) {
  const p = playerById(id);
  if (!p) return 'Unknown';
  return p.number != null && p.number !== '' ? `#${p.number} ${p.name}` : p.name;
}

/* ═══════════════════════════════════════════════════════════════ clock ══ */

function elapsed(g = state.game) {
  if (!g) return 0;
  const c = g.clock;
  return Math.max(0, c.accumMs + (c.running ? Date.now() - c.startedAt : 0));
}

function startClock() {
  const g = state.game;
  if (g.clock.running) return;
  g.clock.running = true;
  g.clock.startedAt = Date.now();
  if (!g.events.some((e) => e.type === 'kickoff' || e.type === 'second_half')) {
    logMarker(g.period === 1 ? 'kickoff' : 'second_half');
  }
  persistGame();
  requestWakeLock();
  renderGame();
}

function stopClock() {
  const g = state.game;
  if (!g.clock.running) return;
  g.clock.accumMs = elapsed(g);
  g.clock.running = false;
  g.clock.startedAt = null;
  persistGame();
  releaseWakeLock();
  renderGame();
}

/* ═══════════════════════════════════════════════════════════ game core ══ */

function newGame(teamId, form) {
  const now = Date.now();
  return {
    id: uid(),
    team_id: teamId,
    opponent: form.opponent || 'Opponent',
    location: form.location || '',
    home_away: form.home_away,
    kind: form.kind,
    half_length_min: form.half_length_min,
    kickoff_at: now,
    // 'en-CA' formats as YYYY-MM-DD; captured locally so exports show the day
    // the game was actually played rather than the UTC day.
    local_date: new Date(now).toLocaleDateString('en-CA'),
    status: 'live',
    period: 1,
    h1_ms: null,
    h2_ms: null,
    us_score: 0,
    them_score: 0,
    starters: form.starters,
    present: form.present,
    notes: '',
    clock: { running: false, startedAt: null, accumMs: 0 },
    events: [],
    created_at: now,
    updated_at: now,
  };
}

function gameForServer(g) {
  return {
    id: g.id,
    team_id: g.team_id,
    opponent: g.opponent,
    location: g.location,
    home_away: g.home_away,
    kind: g.kind,
    half_length_min: g.half_length_min,
    kickoff_at: g.kickoff_at,
    local_date: g.local_date ?? null,
    status: g.status,
    period: g.period,
    h1_ms: g.h1_ms,
    h2_ms: g.h2_ms,
    us_score: scoreOf(g, 'us'),
    them_score: scoreOf(g, 'them'),
    starters: { starters: g.starters || [], present: g.present || [] },
    notes: g.notes || '',
    created_at: g.created_at,
    updated_at: g.updated_at || Date.now(),
  };
}

const liveEvents = (g = state.game) => (g?.events || []).filter((e) => !e.deleted);

function scoreOf(g, side) {
  return liveEvents(g).filter((e) => e.side === side && SCORING.has(e.type)).length;
}

function countOf(side, type) {
  return liveEvents().filter((e) => e.side === side && e.type === type).length;
}

function currentKeeper(g = state.game) {
  const changes = liveEvents(g)
    .filter((e) => e.type === 'keeper_in' && e.side === 'us')
    .sort((a, b) => a.wall_at - b.wall_at);
  if (changes.length) return changes[changes.length - 1].player_id;
  return g?.keeper_id || null;
}

function onFieldNow(g = state.game) {
  const set = new Set(g.starters || []);
  for (const e of liveEvents(g).filter((x) => x.type === 'sub').sort((a, b) => a.wall_at - b.wall_at)) {
    if (e.sub_out_id) set.delete(e.sub_out_id);
    if (e.sub_in_id) set.add(e.sub_in_id);
  }
  return set;
}

function pushEvent(partial) {
  const g = state.game;
  const ev = {
    id: uid(),
    game_id: g.id,
    side: 'us',
    player_id: null,
    player_number: null,
    assist_id: null,
    assist_number: null,
    sub_out_id: null,
    sub_in_id: null,
    period: g.period,
    clock_ms: elapsed(g),
    wall_at: Date.now(),
    note: null,
    group_id: null,
    deleted: 0,
    updated_at: Date.now(),
    ...partial,
  };
  g.events.push(ev);
  persistGame();
  queue('events', ev);
  return ev;
}

function logMarker(type) {
  return pushEvent({ type, side: 'us' });
}

function updateEvent(ev, changes) {
  Object.assign(ev, changes, { updated_at: Date.now() });
  persistGame();
  queue('events', ev);
  renderGame();
}

/** Every event a single tap produced, including the one passed in. */
function groupOf(ev, g = state.game) {
  if (!ev.group_id) return [ev];
  return g.events.filter((e) => e.group_id === ev.group_id && !e.deleted);
}

/** Deletes an event and anything logged alongside it by the same tap. */
function deleteGroup(ev) {
  const targets = groupOf(ev);
  for (const t of targets) {
    t.deleted = 1;
    t.updated_at = Date.now();
    queue('events', t);
  }
  persistGame();
  renderGame();
  return targets;
}

function undoLast() {
  const g = state.game;
  const idx = [...g.events].reverse().findIndex((e) => !e.deleted && !MARKERS[e.type]);
  if (idx === -1) return toast('Nothing to undo');
  const ev = g.events[g.events.length - 1 - idx];
  const label = groupLabel(groupOf(ev), ev);
  deleteGroup(ev);
  buzz(20);
  toast(`Undid ${label}`);
}

/** Short name for a group of events, used by undo and the log. */
function groupLabel(events, lead) {
  const types = new Set(events.map((e) => e.type));
  if (types.has('goal')) return 'Goal';
  if (types.has('corner') && types.has('save')) return 'Shot (deflected, corner)';
  if (types.has('shot_on') && types.has('save')) return 'Shot (goalie save)';
  if (types.has('shot_off')) return 'Shot (off target)';
  return TYPE_MAP[lead.type]?.label ?? lead.type;
}

/* ═══════════════════════════════════════════════════════════════ sync ══ */

function scheduleSync(delay = 1200) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flush, delay);
}

function outboxSize() {
  return Object.values(state.outbox).reduce((n, b) => n + Object.keys(b).length, 0);
}

async function flush() {
  if (!navigator.onLine) return renderSyncPill();
  const pending = outboxSize();
  if (!pending) return renderSyncPill();

  // Always ship the current game alongside its events. Events carry a foreign
  // key to games, so an event arriving before its game is rejected outright —
  // which is exactly what happens when the queue drains out of order.
  const games = { ...state.outbox.games };
  if (state.game) games[state.game.id] ||= gameForServer(state.game);

  const payload = {
    teams: Object.values(state.outbox.teams),
    players: Object.values(state.outbox.players),
    games: Object.values(games),
    events: Object.values(state.outbox.events),
  };

  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`sync ${res.status}`);
    const data = await res.json();
    // Clear only what the server confirmed, so anything queued while the
    // request was in flight survives.
    for (const bucket of ['teams', 'players', 'games', 'events']) {
      for (const id of data.wrote?.[bucket] ?? []) delete state.outbox[bucket][id];
    }
    // A row the server keeps refusing (an orphan, say) would otherwise sit in
    // the queue forever and block the pill from ever clearing. Give it three
    // tries, then drop it and say so rather than retrying to no end.
    for (const r of data.rejected ?? []) {
      const row = state.outbox[r.bucket]?.[r.id];
      if (!row) continue;
      row._rejects = (row._rejects ?? 0) + 1;
      if (row._rejects >= 3) {
        console.warn('dropping unsyncable row', r);
        delete state.outbox[r.bucket][r.id];
        toast('1 change could not be saved');
      }
    }
    save(LS.outbox, state.outbox);
  } catch (err) {
    console.warn('sync deferred', err.message);
    scheduleSync(15000);
  }
  renderSyncPill();
}

function renderSyncPill() {
  const pill = $('#sync-pill');
  const n = outboxSize();
  if (!n) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.className = `sync-pill${navigator.onLine ? '' : ' offline'}`;
  pill.textContent = navigator.onLine ? `syncing ${n}` : `offline · ${n} queued`;
}

async function bootstrapFromServer() {
  try {
    const res = await fetch('/api/bootstrap');
    if (!res.ok) return;
    const data = await res.json();

    if (Array.isArray(data.teams) && data.teams.length) {
      for (const t of data.teams) {
        const local = teamById(t.id);
        if (!local) state.teams.push(t);
        else if ((t.updated_at ?? 0) > (local.updated_at ?? 0)) Object.assign(local, t);
      }
    }
    for (const p of data.players ?? []) {
      const local = playerById(p.id);
      if (!local) state.players.push(p);
      else if ((p.updated_at ?? 0) > (local.updated_at ?? 0)) Object.assign(local, p);
    }
    persistRoster();

    const known = new Set(state.history.map((g) => g.id));
    for (const g of data.games ?? []) {
      if (g.status === 'deleted') continue;
      if (!known.has(g.id) && g.id !== state.game?.id) state.history.push(historyRow(g));
    }
    state.history.sort((a, b) => (b.kickoff_at ?? 0) - (a.kickoff_at ?? 0));
    save(LS.history, state.history);

    if (state.screen === 'home') renderHome();
  } catch {
    /* offline is fine — local data carries the app */
  }
}

function historyRow(g) {
  return {
    id: g.id,
    team_id: g.team_id,
    opponent: g.opponent,
    kickoff_at: g.kickoff_at,
    us_score: g.us_score ?? 0,
    them_score: g.them_score ?? 0,
    kind: g.kind,
    status: g.status,
  };
}

/* ════════════════════════════════════════════════════════════ wake lock ══ */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* denied or unsupported */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* ignore */ }
  wakeLock = null;
}

/* ══════════════════════════════════════════════════════════════ modal ══ */

let modalResolve = null;

function openModal(title, build) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.innerHTML = '';
    build(body, (value) => closeModal(value));
    $('#modal').hidden = false;
  });
}

function closeModal(value = null) {
  $('#modal').hidden = true;
  $('#modal-body').innerHTML = '';
  const r = modalResolve;
  modalResolve = null;
  r?.(value);
}

/**
 * Roster keypad. Resolves to a player id, 'other' (type a number instead),
 * 'none' (no attribution), or null when dismissed.
 */
function pickOurPlayer(title, opts = {}) {
  const g = state.game;
  const present = new Set(g.present?.length ? g.present : playersOf(g.team_id).map((p) => p.id));
  let list = playersOf(g.team_id).filter((p) => present.has(p.id));
  if (opts.only) list = list.filter((p) => opts.only.has(p.id));
  if (opts.exclude) list = list.filter((p) => !opts.exclude.has(p.id));
  const keeper = currentKeeper(g);

  return openModal(title, (body, done) => {
    if (!list.length) {
      body.innerHTML = '<p class="empty">No players available. Add a roster in Settings.</p>';
    }
    const grid = document.createElement('div');
    grid.className = 'num-grid';
    for (const p of list) {
      const b = document.createElement('button');
      b.className = `num-btn${p.id === keeper ? ' keeper' : ''}`;
      b.innerHTML = `<span class="nb-num">${p.number ?? '–'}</span><span class="nb-name">${esc(p.name)}</span>`;
      b.onclick = () => { buzz(); done(p.id); };
      grid.append(b);
    }
    body.append(grid);

    // Guest players, call-ups, and anyone you only caught the number of.
    if (opts.allowOther !== false) {
      const other = document.createElement('button');
      other.className = 'btn';
      other.textContent = 'Other player — type the number';
      other.onclick = () => { buzz(); done('other'); };
      body.append(other);
    }

    const none = document.createElement('button');
    none.className = 'btn btn-ghost';
    none.textContent = opts.noneLabel || 'Unknown / no player';
    none.onclick = () => { buzz(); done('none'); };
    body.append(none);
  });
}

/** Jersey-number pad. Resolves to a number, 'none', or null when dismissed. */
function pickNumber(title, opts = {}) {
  return openModal(title, (body, done) => {
    let buf = '';
    const display = document.createElement('div');
    display.className = 'keypad-display';
    const paint = () => { display.textContent = buf === '' ? '—' : `#${buf}`; };
    paint();

    const pad = document.createElement('div');
    pad.className = 'keypad';
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK']) {
      const b = document.createElement('button');
      b.textContent = k;
      b.onclick = () => {
        buzz();
        if (k === '⌫') buf = buf.slice(0, -1);
        else if (k === 'OK') return done(buf === '' ? 'none' : Number(buf));
        else if (buf.length < 2) buf += k;
        paint();
      };
      pad.append(b);
    }

    const skip = document.createElement('button');
    skip.className = 'btn btn-ghost';
    skip.textContent = opts.noneLabel || 'No number / unknown';
    skip.onclick = () => { buzz(); done('none'); };

    body.append(display, pad, skip);
  });
}

function confirmModal(title, message, confirmLabel = 'Confirm', danger = false) {
  return openModal(title, (body, done) => {
    const p = document.createElement('p');
    p.textContent = message;
    p.style.color = 'var(--muted)';
    const yes = document.createElement('button');
    yes.className = `btn ${danger ? 'btn-danger' : 'btn-primary'} btn-lg`;
    yes.textContent = confirmLabel;
    yes.onclick = () => done(true);
    const no = document.createElement('button');
    no.className = 'btn btn-ghost';
    no.textContent = 'Cancel';
    no.onclick = () => done(false);
    body.append(p, yes, no);
  });
}

/* ══════════════════════════════════════════════════════ logging a stat ══ */

async function logStat(side, key) {
  const def = BUTTON_MAP[key];
  if (!def) return;
  buzz();

  if (def.flow === 'shot') return logShot(side);

  const label = btnLabel(def);

  // A save by our own keeper needs no prompt — we already know who it is.
  if (side === 'us' && def.prompt === 'keeper') {
    const keeper = currentKeeper();
    if (keeper) {
      pushEvent({ side, type: def.type, player_id: keeper });
      toast(`Save — ${playerLabel(keeper)}`);
      return renderGame();
    }
  }

  const who = await askWho(side, `${label} — `);
  if (who === null) return;

  const ev = pushEvent({ side, type: def.type, player_id: who.player_id, player_number: who.player_number });

  if (TYPE_MAP[def.type]?.assist) {
    const assist = await askAssist(side, who);
    if (assist) updateEvent(ev, { assist_id: assist.player_id, assist_number: assist.player_number });
  }

  toast(`${label}${who.label ? ` — ${who.label}` : ''}`);
  renderGame();
}

/**
 * Ask who did it — our roster keypad only. Opposition events carry no player
 * attribution, so their side resolves immediately with no prompt: one less
 * tap while the ball is still moving. Returns null if cancelled, or
 * { player_id, player_number, label } with everything null when "unknown"
 * is chosen.
 */
async function askWho(side, prefix, opts = {}) {
  const blank = { player_id: null, player_number: null, label: '' };

  if (side !== 'us') return blank;

  const byNumber = async () => {
    const n = await pickNumber(`${prefix}jersey #`, opts);
    if (n === null) return null;
    return n === 'none' ? blank : { player_id: null, player_number: n, label: `#${n}` };
  };

  const picked = await pickOurPlayer(`${prefix}who?`, opts);
  if (picked === null) return null;
  if (picked === 'none') return blank;
  if (picked === 'other') return byNumber();
  return { player_id: picked, player_number: null, label: playerLabel(picked) };
}

/**
 * Assists come from our roster (off-roster players of ours as a typed jersey
 * number). Opposition goals skip the question along with everything else.
 */
async function askAssist(side, scorer) {
  const exclude = scorer?.player_id ? new Set([scorer.player_id]) : undefined;
  return askWho(side, 'Assist — ', { noneLabel: 'No assist', exclude });
}

/**
 * One tap covers a whole shot: who took it, then what happened to it.
 *
 *   Saved     → shot on goal for the shooter + a save for the other keeper
 *   Goal      → the goal, then an optional assist
 *   Out       → shot off target + a goal kick to the other team
 *   Deflected → shot on goal + a save for the keeper who tipped it
 *               + a corner kick back to the shooting team
 *
 * The events a shot produces share a group_id so undo, edit, and the log
 * treat them as the single thing they are.
 */
async function logShot(side) {
  const g = state.game;
  const other = side === 'us' ? 'them' : 'us';

  const who = await askWho(side, 'Shot — ');
  if (who === null) return;

  const outcome = await pickShotOutcome(side, who.label);
  if (!outcome) return;

  const group = uid();
  const shooter = {
    side,
    player_id: who.player_id,
    player_number: who.player_number,
    group_id: group,
  };
  const suffix = who.label ? ` — ${who.label}` : '';

  if (outcome === 'goal') {
    const ev = pushEvent({ ...shooter, type: 'goal' });
    const assist = await askAssist(side, who);
    if (assist) updateEvent(ev, { assist_id: assist.player_id, assist_number: assist.player_number });
    toast(`Goal${suffix}`);
  } else if (outcome === 'save') {
    pushEvent({ ...shooter, type: 'shot_on' });
    const keeper = other === 'us' ? currentKeeper() : null;
    pushEvent({ side: other, type: 'save', player_id: keeper, group_id: group });
    toast(keeper ? `Saved by ${playerLabel(keeper)}` : `Shot saved${suffix}`);
  } else if (outcome === 'deflect') {
    pushEvent({ ...shooter, type: 'shot_on' });
    const keeper = other === 'us' ? currentKeeper() : null;
    pushEvent({ side: other, type: 'save', player_id: keeper, group_id: group });
    pushEvent({ side, type: 'corner', group_id: group });
    toast(`Deflected${suffix} · corner kick`);
  } else {
    pushEvent({ ...shooter, type: 'shot_off' });
    pushEvent({ side: other, type: 'goal_kick', group_id: group });
    toast(`Off target${suffix} · goal kick`);
  }
  renderGame();
}

/** Saved / Goal / Deflected / Out. Returns null if dismissed — nothing is logged. */
function pickShotOutcome(side, who) {
  const g = state.game;
  const ourName = teamById(g.team_id)?.label || 'us';
  const shooterName = side === 'us' ? ourName : (g.opponent || 'them');
  const otherName = side === 'us' ? (g.opponent || 'them') : ourName;

  return openModal(who ? `Shot — ${who}` : 'Shot', (body, done) => {
    const mk = (label, value, cls) => {
      const b = document.createElement('button');
      b.className = `btn btn-lg ${cls}`;
      b.textContent = label;
      b.onclick = () => { buzz(); done(value); };
      return b;
    };
    body.append(
      mk('Goalie Save', 'save', ''),
      mk('Goal', 'goal', 'btn-goal'),
      mk(`Deflected out — corner to ${shooterName}`, 'deflect', ''),
      mk(`Out — goal kick to ${otherName}`, 'out', 'btn-ghost')
    );
  });
}

/**
 * Substitutions, and the keeper change folded in with them — a keeper coming
 * off is a substitution, and the gloves always have to go somewhere.
 *
 *   Coming off → Going on → (if the keeper left) who is in goal now?
 *
 * "Keeper change only" on the first step covers the other case: two players
 * already on the field swapping the gloves, with nobody leaving.
 */
async function logSub() {
  const field = onFieldNow();
  const keeper = currentKeeper();

  const off = await pickOurPlayer('Coming off', {
    only: field.size ? field : undefined,
    allowOther: false,
    noneLabel: 'Keeper change only',
  });
  if (off === null) return;

  if (off === 'none') {
    const gk = await pickOurPlayer('Who is in goal?', {
      only: field.size ? field : undefined,
      allowOther: false,
      noneLabel: 'Cancel',
    });
    if (!gk || gk === 'none') return;
    pushEvent({ side: 'us', type: 'keeper_in', player_id: gk });
    toast(`${playerLabel(gk)} in goal`);
    return renderGame();
  }

  const on = await pickOurPlayer('Going on', {
    exclude: new Set([off, ...field]),
    allowOther: false,
    noneLabel: 'Nobody',
  });
  if (on === null) return;

  pushEvent({
    side: 'us',
    type: 'sub',
    sub_out_id: off,
    sub_in_id: on === 'none' ? null : on,
  });

  // The keeper just walked off — the gloves need a new owner before play resumes.
  if (off === keeper) {
    const after = onFieldNow();
    const gk = await pickOurPlayer('Who is in goal now?', {
      only: after.size ? after : undefined,
      allowOther: false,
      noneLabel: 'Leave unset',
    });
    if (gk && gk !== 'none') pushEvent({ side: 'us', type: 'keeper_in', player_id: gk });
  }

  toast('Sub logged');
  renderGame();
}

/* ═══════════════════════════════════════════════════════════ rendering ══ */

function showScreen(name) {
  state.screen = name;
  for (const s of document.querySelectorAll('.screen')) s.hidden = true;
  $(`#screen-${name}`).hidden = false;
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'settings') renderSettings();
  if (name === 'history') renderHistory();
}

/* ---------------------------------------------------------------- home -- */

function renderHome() {
  const picker = $('#team-picker');
  picker.innerHTML = '';
  for (const t of state.teams) {
    const b = document.createElement('button');
    b.className = 'team-btn';
    b.innerHTML =
      `<span class="team-dot" style="background:${esc(t.color || '#3b82f6')}"></span>` +
      `<span>${esc(t.label)}</span>` +
      `<span class="club">${esc(t.club_name || `${playersOf(t.id).length} players`)}</span>`;
    b.onclick = () => openSetup(t.id);
    picker.append(b);
  }

  const g = state.game;
  const card = $('#resume-card');
  if (g && g.status === 'live') {
    card.hidden = false;
    $('#resume-desc').textContent =
      `${teamById(g.team_id)?.label ?? 'Game'} vs ${g.opponent} — ` +
      `${scoreOf(g, 'us')}–${scoreOf(g, 'them')} · H${g.period} ${mmss(elapsed(g))}`;
  } else {
    card.hidden = true;
  }

  renderGameList($('#recent-games'), state.history.slice(0, 6));
}

function renderGameList(container, games) {
  container.innerHTML = '';
  if (!games.length) {
    container.innerHTML = '<div class="empty">No games yet.</div>';
    return;
  }
  for (const g of games) {
    const cls = g.us_score > g.them_score ? 'gr-w' : g.us_score < g.them_score ? 'gr-l' : 'gr-d';
    const b = document.createElement('button');
    b.className = 'game-row';
    b.innerHTML =
      `<div class="gr-main">` +
      `<div class="gr-opp">${esc(teamById(g.team_id)?.label ?? '')} vs ${esc(g.opponent || '—')}</div>` +
      `<div class="gr-meta">${esc(fmtDate(g.kickoff_at))}${g.kind ? ` · ${esc(g.kind)}` : ''}</div>` +
      `</div><div class="gr-score ${cls}">${g.us_score}–${g.them_score}</div>`;
    b.onclick = () => openSummary(g.id);
    container.append(b);
  }
}

function renderHistory() {
  renderGameList($('#history-body'), state.history);
}

/* --------------------------------------------------------------- setup -- */

function openSetup(teamId) {
  const team = teamById(teamId);
  const roster = playersOf(teamId);
  state.setup = {
    team_id: teamId,
    // Everyone starts on the bench; you promote your starters. Nobody is
    // marked absent by default because most weeks everybody shows up.
    status: Object.fromEntries(roster.map((p) => [p.id, 'bench'])),
  };

  $('#setup-title').textContent = `New game — ${team.label}`;
  $('#f-half').value = team.half_length_min ?? 25;
  $('#f-opponent').value = '';
  $('#f-location').value = '';
  renderLineup();
  showScreen('setup');
}

function renderLineup() {
  const list = $('#lineup-list');
  const roster = playersOf(state.setup.team_id);
  list.innerHTML = '';

  if (!roster.length) {
    list.innerHTML =
      '<div class="empty">No roster yet — add players in Settings first.</div>';
    $('#lineup-count').textContent = '';
    $('#f-keeper').innerHTML = '<option value="">— none —</option>';
    return;
  }

  for (const p of roster) {
    const row = document.createElement('div');
    row.className = 'lineup-row';
    row.innerHTML =
      `<div class="ln-num">${p.number ?? '–'}</div>` +
      `<div class="ln-name">${esc(p.name)}</div>`;

    const seg = document.createElement('div');
    seg.className = 'seg';
    for (const [value, label] of [['start', 'Start'], ['bench', 'Bench'], ['out', 'Out']]) {
      const b = document.createElement('button');
      b.dataset.v = value;
      b.textContent = label;
      b.setAttribute('aria-pressed', String(state.setup.status[p.id] === value));
      b.onclick = () => {
        state.setup.status[p.id] = value;
        buzz();
        renderLineup();
      };
      seg.append(b);
    }
    row.append(seg);
    list.append(row);
  }

  const starters = roster.filter((p) => state.setup.status[p.id] === 'start');
  const out = roster.filter((p) => state.setup.status[p.id] === 'out');
  $('#lineup-count').textContent = `${starters.length} starting · ${out.length} out`;

  const keeperSel = $('#f-keeper');
  const prev = keeperSel.value;
  keeperSel.innerHTML = '<option value="">— none —</option>';
  for (const p of roster.filter((x) => state.setup.status[x.id] !== 'out')) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = playerLabel(p.id);
    keeperSel.append(o);
  }
  keeperSel.value = prev;
}

function startGameFromSetup() {
  const s = state.setup;
  const roster = playersOf(s.team_id);
  const present = roster.filter((p) => s.status[p.id] !== 'out').map((p) => p.id);
  const starters = roster.filter((p) => s.status[p.id] === 'start').map((p) => p.id);

  const g = newGame(s.team_id, {
    opponent: $('#f-opponent').value.trim(),
    location: $('#f-location').value.trim(),
    home_away: $('#f-homeaway').value,
    kind: $('#f-kind').value,
    half_length_min: Number($('#f-half').value) || 25,
    present,
    starters,
  });

  state.game = g;
  const keeper = $('#f-keeper').value;
  persistGame();
  if (keeper) pushEvent({ side: 'us', type: 'keeper_in', player_id: keeper });

  state.history = state.history.filter((h) => h.id !== g.id);
  state.history.unshift(historyRow(gameForServer(g)));
  save(LS.history, state.history);

  showScreen('game');
  renderGame();
}

/* ---------------------------------------------------------------- game -- */

function buildStatGrids() {
  for (const side of ['us', 'them']) {
    const grid = document.querySelector(`.stat-grid[data-side="${side}"]`);
    grid.innerHTML = '';
    const expanded = grid.dataset.expanded === '1';
    const defs = BUTTONS.filter(
      (b) => (b.tier === 1 || expanded) && !(b.usOnly && side === 'them')
    );
    for (const def of defs) {
      const b = document.createElement('button');
      b.className = `stat-btn${def.primary ? ' primary' : ''}${def.cls ? ` ${def.cls}` : ''}`;
      b.dataset.key = def.key;
      b.innerHTML = `<span class="sb-label">${btnLabel(def)}</span><span class="sb-count">0</span>`;
      b.onclick = () => logStat(side, def.key);
      grid.append(b);
    }
    document.querySelector(`.more-btn[data-more="${side}"]`).textContent = expanded ? 'Less' : 'More…';
  }
}

function renderGame() {
  const g = state.game;
  if (!g) return;
  const team = teamById(g.team_id);

  $('#game-title').textContent = `${team?.label ?? ''} vs ${g.opponent}`;
  $('#sb-us').textContent = team?.label ?? 'Us';
  $('#sb-them').textContent = g.opponent;
  // The columns are headed by the club name — that is what the two sides of the
  // pitch are called. The scoreboard keeps the short name so it fits.
  $('#col-us-head').textContent = team?.club_name?.trim() || team?.label || 'Us';
  $('#col-them-head').textContent = g.opponent;
  $('#sb-us-score').textContent = scoreOf(g, 'us');
  $('#sb-them-score').textContent = scoreOf(g, 'them');

  const clockEl = $('#clock');
  clockEl.textContent = mmss(elapsed(g));
  clockEl.classList.toggle('running', g.clock.running);

  const atHalftime = g.period === 2 && !g.clock.running && elapsed(g) === 0;
  $('#period-label').textContent =
    g.status === 'final' ? 'Full time' : atHalftime ? 'Halftime' : g.period === 1 ? '1st Half' : '2nd Half';

  const play = $('#btn-play');
  play.textContent = g.clock.running ? 'Pause' : elapsed(g) > 0 ? 'Resume' : 'Start';
  play.className = `btn grow ${g.clock.running ? 'btn-ghost' : 'btn-primary'}`;
  play.disabled = g.status === 'final';
  $('#btn-half').disabled = g.status === 'final' || g.period === 2;
  $('#btn-half').textContent = g.period === 1 ? 'Half' : '2nd';

  const keeper = currentKeeper(g);
  const halfLen = (g.half_length_min ?? 25) * 60000;
  const over = elapsed(g) > halfLen;
  // Saves live behind "More…" now that Shot is one button, so surface the
  // keeper's count here where it is always visible.
  const saves = liveEvents(g).filter((e) => e.side === 'us' && e.type === 'save').length;
  $('#keeper-line').innerHTML =
    `${keeper ? `In goal: <b>${esc(playerLabel(keeper))}</b> · ${saves} save${saves === 1 ? '' : 's'}`
              : 'No keeper set'}` +
    ` · ${g.half_length_min}′ halves` +
    (over ? ' · <b style="color:var(--bad)">over</b>' : '');

  // stat counts
  for (const side of ['us', 'them']) {
    for (const btn of document.querySelectorAll(`.stat-grid[data-side="${side}"] .stat-btn`)) {
      const def = BUTTON_MAP[btn.dataset.key];
      const n = btnCounts(def).reduce((sum, t) => sum + countOf(side, t), 0);
      btn.querySelector('.sb-count').textContent = n;
      btn.classList.toggle('has', n > 0);
    }
  }

  renderEventLog();
}

function eventText(e) {
  if (MARKERS[e.type]) return MARKERS[e.type];
  const def = TYPE_MAP[e.type];
  const label = def?.label ?? e.type;

  if (e.type === 'sub') {
    const off = e.sub_out_id ? playerLabel(e.sub_out_id) : '—';
    const on = e.sub_in_id ? playerLabel(e.sub_in_id) : '—';
    return `Sub: ${on} in for ${off}`;
  }
  if (e.type === 'keeper_in') return `${playerLabel(e.player_id)} in goal`;

  const whoK = whoKey(e.player_id, e.player_number);
  const who = whoK ? ` — ${whoLabel(whoK)}` : '';

  const assistK = whoKey(e.assist_id, e.assist_number);
  const extra = assistK ? ` (assist ${whoLabel(assistK)})` : '';
  return `${label}${who}${extra}`;
}

function renderEventLog() {
  const g = state.game;
  const log = $('#event-log');
  log.innerHTML = '';
  const rows = groupedEvents(g)
    .sort((a, b) =>
      b.lead.period - a.lead.period ||
      b.lead.clock_ms - a.lead.clock_ms ||
      b.lead.wall_at - a.lead.wall_at);

  if (!rows.length) {
    log.innerHTML = '<div class="empty">Nothing logged yet.</div>';
    return;
  }

  for (const grp of rows) {
    const e = grp.lead;
    const row = document.createElement('button');
    const marker = !!MARKERS[e.type];
    row.className = `log-row ${dotSide(grp)}${marker ? ' marker' : ''}`;
    row.innerHTML =
      `<span class="lg-time">H${e.period} ${mmss(e.clock_ms)}</span>` +
      (marker ? '' : '<span class="lg-dot"></span>') +
      `<span class="lg-text">${esc(groupText(grp))}</span>`;
    row.onclick = () => editEvent(e);
    log.append(row);
  }
}

/**
 * The dot on a log row is colored by whoever comes away with the ball, not by
 * who acted. For a grouped shot that is the restart event's side: a save or a
 * goal kick belongs to the defending team, a corner off a deflection goes back
 * to the team that took the shot. Ungrouped events keep their own side.
 */
function dotSide(grp) {
  // A deflection logs both a save and the corner; the corner is the restart.
  const restart =
    grp.events.find((e) => e.type === 'corner') ??
    grp.events.find((e) => e.type === 'save' || e.type === 'goal_kick');
  return (restart ?? grp.lead).side;
}

/**
 * Collapses paired events back into the single action that created them, so a
 * shot is one line in the log rather than two. The lead is the shooter's event,
 * which is always pushed first.
 */
function groupedEvents(g) {
  const live = liveEvents(g);
  const seen = new Set();
  const out = [];
  for (const e of live) {
    if (!e.group_id) { out.push({ lead: e, events: [e] }); continue; }
    if (seen.has(e.group_id)) continue;
    seen.add(e.group_id);
    out.push({ lead: e, events: live.filter((x) => x.group_id === e.group_id) });
  }
  return out;
}

function groupText(grp) {
  const { lead, events } = grp;
  if (events.length < 2) return eventText(lead);

  const types = new Set(events.map((e) => e.type));
  const leadKey = whoKey(lead.player_id, lead.player_number);
  const who = leadKey ? ` — ${whoLabel(leadKey)}` : '';

  if (types.has('goal')) return eventText(lead);
  if (types.has('corner') && types.has('save')) {
    const keeper = events.find((e) => e.type === 'save')?.player_id;
    return `Shot deflected out${who}${keeper ? ` (${playerLabel(keeper)})` : ''} · corner`;
  }
  if (types.has('save')) {
    const keeper = events.find((e) => e.type === 'save')?.player_id;
    return `Shot saved${who}${keeper ? ` (${playerLabel(keeper)})` : ''}`;
  }
  if (types.has('shot_off')) return `Shot off target${who}`;
  return eventText(lead);
}

async function editEvent(e) {
  const action = await openModal(eventText(e), (body, done) => {
    const mk = (label, value, cls = 'btn') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = () => done(value);
      return b;
    };
    if (!MARKERS[e.type]) {
      body.append(mk(e.side === 'us' ? 'Change player' : 'Change jersey #', 'player'));
      if (e.side === 'us' && TYPE_MAP[e.type]?.assist) body.append(mk('Change assist', 'assist'));
      body.append(mk('Adjust time', 'time'));
      // Switching sides on a paired event would split the pair across teams.
      if (!e.group_id) body.append(mk('Switch side', 'side'));
    }
    body.append(mk('Delete event', 'delete', 'btn btn-danger'));
  });

  if (action === 'delete') {
    const n = deleteGroup(e).length;
    return toast(n > 1 ? `Deleted (${n} entries)` : 'Deleted');
  }
  if (action === 'player') {
    if (e.side === 'us') {
      const who = await askWho(e.side, 'Change — ');
      if (who) updateEvent(e, { player_id: who.player_id, player_number: who.player_number });
    } else {
      // askWho never prompts for the opposition now, so the deliberate
      // "attach a jersey number afterwards" path asks for it directly.
      const n = await pickNumber('Change — jersey #');
      if (n !== null) updateEvent(e, { player_id: null, player_number: n === 'none' ? null : n });
    }
  }
  if (action === 'assist') {
    const assist = await askAssist(e.side, null);
    if (assist) updateEvent(e, { assist_id: assist.player_id, assist_number: assist.player_number });
  }
  if (action === 'side') {
    updateEvent(e, { side: e.side === 'us' ? 'them' : 'us', player_id: null, player_number: null });
  }
  if (action === 'time') {
    const ms = await pickClock('Event time', e.clock_ms);
    // Move everything the same tap produced, or the pair drifts apart.
    if (ms !== null) for (const g of groupOf(e)) updateEvent(g, { clock_ms: ms });
  }
}

/** mm:ss entry pad. Returns milliseconds or null. */
function pickClock(title, currentMs = 0) {
  return openModal(title, (body, done) => {
    let buf = '';
    const display = document.createElement('div');
    display.className = 'keypad-display';
    const paint = () => {
      const padded = buf.padStart(4, '0');
      display.textContent = buf === '' ? mmss(currentMs) : `${padded.slice(0, 2)}:${padded.slice(2)}`;
    };
    paint();

    const pad = document.createElement('div');
    pad.className = 'keypad';
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK']) {
      const b = document.createElement('button');
      b.textContent = k;
      b.onclick = () => {
        buzz();
        if (k === '⌫') buf = buf.slice(0, -1);
        else if (k === 'OK') {
          if (buf === '') return done(currentMs);
          const p = buf.padStart(4, '0');
          return done((Number(p.slice(0, 2)) * 60 + Number(p.slice(2))) * 1000);
        } else if (buf.length < 4) buf += k;
        paint();
      };
      pad.append(b);
    }
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Enter as MMSS — e.g. 1435 for 14:35.';
    body.append(display, pad, hint);
  });
}

/* ------------------------------------------------------------- halftime -- */

async function doHalftime() {
  const g = state.game;
  if (g.period !== 1) return;
  const ok = await confirmModal(
    'End the first half?',
    `Splits at ${mmss(elapsed(g))} and resets the clock for the second half.`,
    'End first half'
  );
  if (!ok) return;

  g.h1_ms = elapsed(g);
  logMarker('half_time');
  g.clock = { running: false, startedAt: null, accumMs: 0 };
  g.period = 2;
  persistGame();
  releaseWakeLock();
  renderGame();
  toast(`Halftime — ${mmss(g.h1_ms)}`);
}

async function doEndGame() {
  const g = state.game;
  const ok = await confirmModal(
    'End the game?',
    `Final: ${scoreOf(g, 'us')}–${scoreOf(g, 'them')}. You can still edit events afterwards.`,
    'End game'
  );
  if (!ok) return;

  if (g.period === 1) g.h1_ms = elapsed(g);
  else g.h2_ms = elapsed(g);
  logMarker('full_time');
  g.clock.running = false;
  g.clock.accumMs = elapsed(g);
  g.clock.startedAt = null;
  g.status = 'final';
  g.us_score = scoreOf(g, 'us');
  g.them_score = scoreOf(g, 'them');
  persistGame();
  releaseWakeLock();

  state.history = state.history.filter((h) => h.id !== g.id);
  state.history.unshift(historyRow(gameForServer(g)));
  save(LS.history, state.history);

  state.viewingGame = g;
  flush();
  openSummary(g.id);
}

/* ------------------------------------------------------------- summary -- */

async function openSummary(gameId) {
  showScreen('summary');
  const body = $('#summary-body');

  let g = state.game?.id === gameId ? state.game : null;
  if (!g) {
    body.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const res = await fetch(`/api/games/${gameId}`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();
      let starters = [];
      let present = [];
      try {
        const parsed = JSON.parse(data.game.starters || '{}');
        starters = parsed.starters ?? [];
        present = parsed.present ?? [];
      } catch { /* older rows */ }
      g = { ...data.game, starters, present, events: data.events };
      for (const p of data.players ?? []) if (!playerById(p.id)) state.players.push(p);
    } catch {
      body.innerHTML = '<div class="empty">That game isn’t available offline yet.</div>';
      return;
    }
  }
  state.viewingGame = g;
  renderSummary(g);
}

function renderSummary(g) {
  const body = $('#summary-body');
  const team = teamById(g.team_id);
  const events = (g.events || []).filter((e) => !e.deleted);
  const us = events.filter((e) => e.side === 'us' && SCORING.has(e.type)).length;
  const them = events.filter((e) => e.side === 'them' && SCORING.has(e.type)).length;
  const result = us > them ? 'Win' : us < them ? 'Loss' : 'Draw';

  // SH and SOG are derived: a goal is also a shot, and a shot on goal that was
  // saved is stored as shot_on. Counting raw types alone would undercount both.
  const statCols = [
    ['goal', 'G'], ['assist', 'A'], ['sh', 'SH'], ['sog', 'SOG'],
    ['save', 'SV'], ['corner', 'CK'], ['throw_in', 'TI'], ['goal_kick', 'GK'],
    ['free_kick', 'FK'], ['foul', 'F'], ['offside', 'OFF'], ['block', 'BLK'],
  ];

  const perPlayer = new Map();
  const bump = (id, key) => {
    if (!id) return;
    if (!perPlayer.has(id)) perPlayer.set(id, {});
    const row = perPlayer.get(id);
    row[key] = (row[key] ?? 0) + 1;
  };
  for (const e of events.filter((x) => x.side === 'us')) {
    const k = whoKey(e.player_id, e.player_number);
    bump(k, e.type);
    bump(whoKey(e.assist_id, e.assist_number), 'assist');
    if (['goal', 'pk_scored', 'shot_on'].includes(e.type)) bump(k, 'sog');
    if (['goal', 'pk_scored', 'pk_missed', 'shot_on', 'shot_off'].includes(e.type)) bump(k, 'sh');
  }

  const mins = minutesPlayed(g, events);
  const showMins = mins.size > 0;

  const rosterIds = [...new Set([
    ...(g.present || []),
    ...perPlayer.keys(),
    ...mins.keys(),
  ])].filter(Boolean);

  const teamTotal = (side, type) => events.filter((e) => e.side === side && e.type === type).length;

  body.innerHTML = `
    <div class="card">
      <div class="score-row">
        <div class="score-side"><div class="score-name">${esc(team?.label ?? 'Us')}</div><div class="score-num">${us}</div></div>
        <div class="score-mid"><div class="period">${esc(result)}</div><div class="hint">${esc(fmtDate(g.kickoff_at))}</div></div>
        <div class="score-side"><div class="score-name">${esc(g.opponent || 'Them')}</div><div class="score-num">${them}</div></div>
      </div>
      <div class="keeper-line">
        ${esc([g.kind, g.home_away, g.location].filter(Boolean).join(' · '))}
        ${g.h1_ms ? ` · H1 ${mmss(g.h1_ms)}` : ''}${g.h2_ms ? ` · H2 ${mmss(g.h2_ms)}` : ''}
      </div>
    </div>

    <h2 class="section-label">Team totals</h2>
    <div class="card table-scroll">
      <table class="box">
        <thead><tr><th>Stat</th><th>${esc(team?.label ?? 'Us')}</th><th>${esc(g.opponent || 'Them')}</th></tr></thead>
        <tbody>
          ${EVENT_TYPES.filter((t) => !t.usOnly)
            .map((t) => ({ t, a: teamTotal('us', t.type), b: teamTotal('them', t.type) }))
            .filter((r) => r.a || r.b)
            .map((r) => `<tr><td>${r.t.label}</td><td>${r.a}</td><td>${r.b}</td></tr>`)
            .join('') || '<tr><td colspan="3" class="hint">No events logged.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2 class="section-label">Box score</h2>
    <div class="card table-scroll">
      <table class="box">
        <thead><tr><th>Player</th>${showMins ? '<th>MIN</th>' : ''}${statCols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody>
          ${rosterIds.length
            ? rosterIds
                .map((id) => {
                  const row = perPlayer.get(id) ?? {};
                  const m = mins.get(id);
                  return `<tr><td>${esc(whoLabel(id))}</td>${
                    showMins ? `<td>${m != null ? Math.round(m / 60000) : '–'}</td>` : ''
                  }${statCols.map(([k]) => `<td>${row[k] ?? 0}</td>`).join('')}</tr>`;
                })
                .join('')
            : '<tr><td class="hint">No player data.</td></tr>'}
        </tbody>
      </table>
    </div>

    <h2 class="section-label">Timeline</h2>
    <div class="event-log" id="summary-timeline"></div>

    <div class="row gap">
      <button class="btn grow" id="btn-copy-summary">Copy summary</button>
      <a class="btn grow" href="/api/export.csv?game=${encodeURIComponent(g.id)}">Export CSV</a>
    </div>
    <button class="btn btn-ghost" id="btn-reopen" ${g.status === 'final' && state.game?.id === g.id ? '' : 'hidden'}>Reopen game</button>
    <button class="btn btn-danger" id="btn-delete-game">Delete game</button>
  `;

  const tl = $('#summary-timeline');
  for (const e of events.slice().sort((a, b) => a.period - b.period || a.clock_ms - b.clock_ms)) {
    const marker = !!MARKERS[e.type];
    const row = document.createElement('div');
    row.className = `log-row ${e.side}${marker ? ' marker' : ''}`;
    row.innerHTML =
      `<span class="lg-time">H${e.period} ${mmss(e.clock_ms)}</span>` +
      (marker ? '' : '<span class="lg-dot"></span>') +
      `<span class="lg-text">${esc(eventText(e))}</span>`;
    tl.append(row);
  }

  $('#btn-copy-summary').onclick = () => copySummary(g, events, us, them);
  $('#btn-reopen').onclick = () => {
    state.game.status = 'live';
    persistGame();
    showScreen('game');
    renderGame();
  };
  $('#btn-delete-game').onclick = async () => {
    const ok = await confirmModal('Delete this game?', 'The game and its events are removed from the app.', 'Delete', true);
    if (!ok) return;
    queue('games', { ...gameForServer(g), status: 'deleted', updated_at: Date.now() });
    state.history = state.history.filter((h) => h.id !== g.id);
    save(LS.history, state.history);
    if (state.game?.id === g.id) { state.game = null; persistGame(); }
    showScreen('home');
  };
}

function minutesPlayed(g, events) {
  const mins = new Map();
  const starters = g.starters || [];
  if (!starters.length) return mins;

  const total = (g.h1_ms || 0) + (g.h2_ms || 0);
  if (!total) return mins;

  const abs = (e) => (e.period === 2 ? g.h1_ms || 0 : 0) + e.clock_ms;
  const since = new Map(starters.map((id) => [id, 0]));
  const add = (id, ms) => mins.set(id, (mins.get(id) ?? 0) + Math.max(0, ms));

  for (const s of events.filter((e) => e.type === 'sub').sort((a, b) => abs(a) - abs(b))) {
    const t = abs(s);
    if (s.sub_out_id && since.has(s.sub_out_id)) {
      add(s.sub_out_id, t - since.get(s.sub_out_id));
      since.delete(s.sub_out_id);
    }
    if (s.sub_in_id) since.set(s.sub_in_id, t);
  }
  for (const [id, t] of since) add(id, total - t);
  return mins;
}

async function copySummary(g, events, us, them) {
  const team = teamById(g.team_id)?.label ?? 'Us';
  const lines = [
    `${team} ${us} – ${them} ${g.opponent || 'Opponent'}`,
    `${fmtDate(g.kickoff_at)}${g.location ? ` · ${g.location}` : ''}`,
    '',
  ];
  const scorers = events.filter((e) => e.side === 'us' && SCORING.has(e.type));
  if (scorers.length) {
    lines.push('Goals:');
    for (const e of scorers) {
      const k = whoKey(e.player_id, e.player_number);
      const a = whoKey(e.assist_id, e.assist_number);
      lines.push(
        `  H${e.period} ${mmss(e.clock_ms)} — ${k ? whoLabel(k) : 'unknown'}` +
          (a ? ` (assist ${whoLabel(a)})` : '')
      );
    }
    lines.push('');
  }
  const saves = events.filter((e) => e.side === 'us' && e.type === 'save').length;
  const sog = events.filter((e) => e.side === 'us' && (e.type === 'shot_on' || SCORING.has(e.type))).length;
  lines.push(`Shots on goal: ${sog} · Saves: ${saves} · Corners: ${events.filter((e) => e.side === 'us' && e.type === 'corner').length}`);

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Summary copied');
  } catch {
    await openModal('Summary', (body, done) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.rows = 12;
      ta.style.cssText = 'width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px;';
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = 'Done';
      b.onclick = () => done(true);
      body.append(ta, b);
    });
  }
}

/* ------------------------------------------------------------ settings -- */

function renderSettings() {
  const body = $('#settings-body');
  body.innerHTML = '';

  for (const team of state.teams) {
    const card = document.createElement('div');
    card.className = 'card stack sm';

    const head = document.createElement('div');
    head.className = 'row gap';
    head.innerHTML =
      `<label class="field grow"><span>Name</span><input value="${esc(team.label)}" data-f="label"></label>` +
      `<label class="field grow"><span>Half (min)</span><input type="number" inputmode="numeric" min="1" max="60" value="${team.half_length_min ?? 25}" data-f="half_length_min"></label>`;
    const club = document.createElement('label');
    club.className = 'field';
    club.innerHTML = `<span>Club / team name</span><input value="${esc(team.club_name || '')}" data-f="club_name">`;

    for (const input of [...head.querySelectorAll('input'), ...club.querySelectorAll('input')]) {
      input.onchange = () => {
        const f = input.dataset.f;
        team[f] = f === 'half_length_min' ? Number(input.value) || 25 : input.value;
        team.updated_at = Date.now();
        persistRoster();
        queue('teams', team);
        toast('Saved');
      };
    }

    const rosterWrap = document.createElement('div');
    rosterWrap.className = 'stack sm';
    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = 'Roster';
    rosterWrap.append(label);

    const roster = playersOf(team.id);
    if (!roster.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No players yet.';
      rosterWrap.append(empty);
    }

    for (const p of roster) {
      const row = document.createElement('div');
      row.className = 'lineup-row';
      row.innerHTML =
        `<input class="ln-num" style="border:1px solid var(--line);width:52px" inputmode="numeric" value="${p.number ?? ''}" data-f="number">` +
        `<input class="ln-name" style="background:var(--bg);border:1px solid var(--line);border-radius:9px;height:36px;padding:0 8px" value="${esc(p.name)}" data-f="name">`;
      for (const input of row.querySelectorAll('input')) {
        input.onchange = () => {
          const f = input.dataset.f;
          p[f] = f === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
          p.updated_at = Date.now();
          persistRoster();
          queue('players', p);
          toast('Saved');
        };
      }
      const del = document.createElement('button');
      del.className = 'icon-btn';
      del.innerHTML = '&times;';
      del.setAttribute('aria-label', `Remove ${p.name}`);
      del.onclick = async () => {
        const ok = await confirmModal('Remove player?', `${playerLabel(p.id)} is hidden from new games. Past stats are kept.`, 'Remove', true);
        if (!ok) return;
        p.active = 0;
        p.updated_at = Date.now();
        persistRoster();
        queue('players', p);
        renderSettings();
      };
      row.append(del);
      rosterWrap.append(row);
    }

    const add = document.createElement('button');
    add.className = 'btn';
    add.textContent = '+ Add player';
    add.onclick = () => {
      state.players.push({
        id: uid(),
        team_id: team.id,
        number: null,
        name: 'New player',
        position: null,
        active: 1,
        sort_order: playersOf(team.id).length,
        updated_at: Date.now(),
      });
      persistRoster();
      queue('players', state.players[state.players.length - 1]);
      renderSettings();
    };
    rosterWrap.append(add);

    card.append(head, club, rosterWrap);
    body.append(card);
  }

  const tools = document.createElement('div');
  tools.className = 'stack sm';
  tools.innerHTML = `
    <h2 class="section-label">Data</h2>
    <a class="btn" href="/api/export.csv">Export all games (CSV)</a>
    <button class="btn" id="btn-force-sync">Sync now</button>
    <p class="hint">${outboxSize()} change(s) waiting to sync.</p>
  `;
  body.append(tools);
  $('#btn-force-sync').onclick = async () => { await flush(); toast('Synced'); renderSettings(); };
}

/* ═══════════════════════════════════════════════════════════════ wiring ══ */

function wire() {
  for (const b of document.querySelectorAll('[data-go]')) {
    b.onclick = () => showScreen(b.dataset.go);
  }

  $('#btn-start-game').onclick = startGameFromSetup;
  $('#btn-resume').onclick = () => { showScreen('game'); renderGame(); };
  $('#btn-discard').onclick = async () => {
    const ok = await confirmModal('Discard this game?', 'The in-progress game is removed from this device.', 'Discard', true);
    if (!ok) return;
    state.game = null;
    persistGame();
    renderHome();
  };

  $('#btn-play').onclick = () => (state.game.clock.running ? stopClock() : startClock());
  $('#btn-half').onclick = doHalftime;
  $('#btn-end').onclick = doEndGame;
  $('#btn-undo').onclick = undoLast;
  $('#btn-sub').onclick = logSub;

  for (const b of document.querySelectorAll('.more-btn')) {
    b.onclick = () => {
      const grid = document.querySelector(`.stat-grid[data-side="${b.dataset.more}"]`);
      grid.dataset.expanded = grid.dataset.expanded === '1' ? '0' : '1';
      buildStatGrids();
      renderGame();
    };
  }

  $('#modal-close').onclick = () => closeModal(null);
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(null); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal(null);
  });

  window.addEventListener('online', () => { renderSyncPill(); flush(); });
  window.addEventListener('offline', renderSyncPill);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // The clock is derived from a timestamp, so it is already correct — we just
    // need to repaint and re-take the wake lock the OS dropped.
    if (state.screen === 'game') { renderGame(); if (state.game?.clock.running) requestWakeLock(); }
    flush();
  });
}

function tick() {
  if (state.screen === 'game' && state.game?.clock.running) {
    const el = $('#clock');
    el.textContent = mmss(elapsed());
  }
  if (state.screen === 'home' && state.game?.status === 'live' && state.game.clock.running) {
    renderHome();
  }
}

function init() {
  hydrate();
  wire();
  buildStatGrids();
  renderSyncPill();

  if (state.game && state.game.status === 'live') {
    showScreen('game');
    renderGame();
    if (state.game.clock.running) requestWakeLock();
  } else {
    showScreen('home');
  }

  tickTimer = setInterval(tick, 250);
  setInterval(flush, 20000);
  bootstrapFromServer();
  flush();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

init();
