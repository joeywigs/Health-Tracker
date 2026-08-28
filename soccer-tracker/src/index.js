const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      const shell = await env.ASSETS.fetch(new URL("/index.html", url));
      return new Response(shell.body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error("api error", err && err.stack);
      return json({ error: String((err && err.message) || err) }, 500);
    }
  }
};

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (path === "/api/health") return json({ ok: true });
  if (path === "/api/bootstrap" && method === "GET") return bootstrap(env);
  if (path === "/api/sync" && method === "POST") return sync(request, env);
  if (path === "/api/games" && method === "GET") return listGames(env, url);

  const gameMatch = path.match(/^\/api\/games\/([\w-]+)$/);
  if (gameMatch && method === "GET") return getGame(env, gameMatch[1]);

  if (path === "/api/export.csv" && method === "GET") return exportCsv(env, url);

  return json({ error: "not found" }, 404);
}

async function bootstrap(env) {
  const [teams, players, games] = await Promise.all([
    env.DB.prepare("SELECT * FROM teams ORDER BY label").all(),
    env.DB.prepare("SELECT * FROM players WHERE active = 1 ORDER BY team_id, sort_order, number").all(),
    env.DB.prepare(
      "SELECT * FROM games ORDER BY COALESCE(kickoff_at, created_at) DESC LIMIT 100"
    ).all()
  ]);
  return json({
    teams: teams.results ?? [],
    players: players.results ?? [],
    games: games.results ?? []
  });
}

async function listGames(env, url) {
  const teamId = url.searchParams.get("team");
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
  const stmt = teamId
    ? env.DB.prepare(
        "SELECT * FROM games WHERE team_id = ?1 ORDER BY COALESCE(kickoff_at, created_at) DESC LIMIT ?2"
      ).bind(teamId, limit)
    : env.DB.prepare(
        "SELECT * FROM games ORDER BY COALESCE(kickoff_at, created_at) DESC LIMIT ?1"
      ).bind(limit);
  const { results } = await stmt.all();
  return json({ games: results ?? [] });
}

async function getGame(env, id) {
  const game = await env.DB.prepare("SELECT * FROM games WHERE id = ?1").bind(id).first();
  if (!game) return json({ error: "not found" }, 404);

  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE game_id = ?1 AND deleted = 0 ORDER BY period, clock_ms, wall_at"
  ).bind(id).all();

  const players = await env.DB.prepare(
    "SELECT * FROM players WHERE team_id = ?1 ORDER BY sort_order, number"
  ).bind(game.team_id).all();

  return json({ game, events: results ?? [], players: players.results ?? [] });
}

async function sync(request, env) {
  const body = await request.json();
  const now = Date.now();

  const ops = [];
  const push = (bucket, id, stmt) => ops.push({ bucket, id, stmt });

  for (const t of asArray(body.teams)) {
    if (!t || !t.id) continue;
    push(
      "teams",
      t.id,
      env.DB.prepare(
        `INSERT INTO teams (id, label, club_name, half_length_min, color, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           club_name = excluded.club_name,
           half_length_min = excluded.half_length_min,
           color = excluded.color,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= teams.updated_at`
      ).bind(t.id, t.label ?? t.id, t.club_name ?? null, int(t.half_length_min, 25), t.color ?? null, int(t.updated_at, now))
    );
  }

  for (const p of asArray(body.players)) {
    if (!p || !p.id || !p.team_id) continue;
    push(
      "players",
      p.id,
      env.DB.prepare(
        `INSERT INTO players (id, team_id, number, name, position, active, sort_order, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           team_id = excluded.team_id,
           number = excluded.number,
           name = excluded.name,
           position = excluded.position,
           active = excluded.active,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= players.updated_at`
      ).bind(
        p.id,
        p.team_id,
        p.number == null || p.number === "" ? null : int(p.number, null),
        p.name ?? "",
        p.position ?? null,
        p.active === false || p.active === 0 ? 0 : 1,
        int(p.sort_order, 0),
        int(p.updated_at, now)
      )
    );
  }

  const games = asArray(body.games).concat(body.game ? [body.game] : []);
  for (const g of games) {
    if (!g || !g.id || !g.team_id) continue;
    push(
      "games",
      g.id,
      env.DB.prepare(
        `INSERT INTO games (id, team_id, opponent, location, home_away, kind, half_length_min,
                            kickoff_at, local_date, status, period, h1_ms, h2_ms, us_score, them_score,
                            starters, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
         ON CONFLICT(id) DO UPDATE SET
           opponent = excluded.opponent,
           location = excluded.location,
           home_away = excluded.home_away,
           kind = excluded.kind,
           half_length_min = excluded.half_length_min,
           kickoff_at = excluded.kickoff_at,
           local_date = excluded.local_date,
           status = excluded.status,
           period = excluded.period,
           h1_ms = excluded.h1_ms,
           h2_ms = excluded.h2_ms,
           us_score = excluded.us_score,
           them_score = excluded.them_score,
           starters = excluded.starters,
           notes = excluded.notes,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= games.updated_at`
      ).bind(
        g.id,
        g.team_id,
        g.opponent ?? null,
        g.location ?? null,
        g.home_away ?? null,
        g.kind ?? null,
        int(g.half_length_min, null),
        int(g.kickoff_at, null),
        g.local_date ?? null,
        g.status ?? "setup",
        int(g.period, 1),
        int(g.h1_ms, null),
        int(g.h2_ms, null),
        int(g.us_score, 0),
        int(g.them_score, 0),
        g.starters ? JSON.stringify(g.starters) : null,
        g.notes ?? null,
        int(g.created_at, now),
        int(g.updated_at, now)
      )
    );
  }

  for (const e of asArray(body.events)) {
    if (!e || !e.id || !e.game_id) continue;
    push(
      "events",
      e.id,
      env.DB.prepare(
        `INSERT INTO events (id, game_id, side, type, player_id, player_number, assist_id,
                             assist_number, sub_out_id, sub_in_id, period, clock_ms, wall_at,
                             note, group_id, deleted, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
         ON CONFLICT(id) DO UPDATE SET
           side = excluded.side,
           type = excluded.type,
           player_id = excluded.player_id,
           player_number = excluded.player_number,
           assist_id = excluded.assist_id,
           assist_number = excluded.assist_number,
           sub_out_id = excluded.sub_out_id,
           sub_in_id = excluded.sub_in_id,
           period = excluded.period,
           clock_ms = excluded.clock_ms,
           wall_at = excluded.wall_at,
           note = excluded.note,
           group_id = excluded.group_id,
           deleted = excluded.deleted,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= events.updated_at`
      ).bind(
        e.id,
        e.game_id,
        e.side ?? "us",
        e.type ?? "unknown",
        e.player_id ?? null,
        e.player_number == null || e.player_number === "" ? null : int(e.player_number, null),
        e.assist_id ?? null,
        e.assist_number == null || e.assist_number === "" ? null : int(e.assist_number, null),
        e.sub_out_id ?? null,
        e.sub_in_id ?? null,
        int(e.period, 1),
        int(e.clock_ms, 0),
        int(e.wall_at, now),
        e.note ?? null,
        e.group_id ?? null,
        e.deleted ? 1 : 0,
        int(e.updated_at, now)
      )
    );
  }

  const wrote = { teams: [], players: [], games: [], events: [] };
  const rejected = [];
  if (!ops.length) return json({ ok: true, wrote, rejected, at: now });

  try {
    await env.DB.batch(ops.map((o) => o.stmt));
    for (const o of ops) wrote[o.bucket].push(o.id);
  } catch (batchErr) {
    console.warn("batch failed, retrying individually:", batchErr.message);
    for (const o of ops) {
      try {
        await o.stmt.run();
        wrote[o.bucket].push(o.id);
      } catch (err) {
        rejected.push({ bucket: o.bucket, id: o.id, error: String(err.message || err) });
      }
    }
  }

  if (rejected.length) console.warn(`sync rejected ${rejected.length} row(s)`, rejected[0]);
  return json({ ok: true, wrote, rejected, at: now });
}

async function exportCsv(env, url) {
  const gameId = url.searchParams.get("game");
  const teamId = url.searchParams.get("team");

  const SELECT = `
    SELECT g.id AS game_id,
           COALESCE(g.local_date, date(g.kickoff_at / 1000, 'unixepoch')) AS game_date,
           g.kickoff_at, g.opponent, t.label AS team,
           e.period, e.clock_ms, e.side, e.type, e.player_number,
           p.name AS player_name, p.number AS player_num,
           a.name AS assist_name, e.assist_number,
           so.name AS sub_out_name, si.name AS sub_in_name,
           e.note
      FROM events e
      JOIN games g ON g.id = e.game_id
      JOIN teams t ON t.id = g.team_id
      LEFT JOIN players p  ON p.id  = e.player_id
      LEFT JOIN players a  ON a.id  = e.assist_id
      LEFT JOIN players so ON so.id = e.sub_out_id
      LEFT JOIN players si ON si.id = e.sub_in_id
     WHERE e.deleted = 0 AND g.status != 'deleted'`;

  const rows = gameId
    ? await env.DB.prepare(`${SELECT} AND e.game_id = ?1 ORDER BY e.period, e.clock_ms, e.wall_at`).bind(gameId).all()
    : await env.DB.prepare(
        `${SELECT} AND (?1 IS NULL OR g.team_id = ?1)
         ORDER BY g.kickoff_at DESC, e.period, e.clock_ms, e.wall_at`
      ).bind(teamId || null).all();

  const header = [
    "game_id",
    "date",
    "team",
    "opponent",
    "half",
    "clock",
    "side",
    "event",
    "player_number",
    "player",
    "assist",
    "detail",
    "note"
  ];

  const lines = [header.join(",")];
  for (const r of rows.results ?? []) {
    const detail = r.type === "sub" ? `${r.sub_in_name ?? "?"} in for ${r.sub_out_name ?? "?"}` : "";
    lines.push(
      [
        r.game_id,
        r.game_date ?? "",
        r.team,
        r.opponent ?? "",
        r.period,
        mmss(r.clock_ms),
        r.side,
        r.type,
        r.player_num ?? r.player_number ?? "",
        r.player_name ?? "",
        r.assist_name ?? (r.assist_number != null ? `#${r.assist_number}` : ""),
        detail,
        r.note ?? ""
      ].map(csvCell).join(",")
    );
  }

  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="soccer-${gameId || teamId || "all"}.csv"`,
      "cache-control": "no-store"
    }
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function int(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function clampInt(v, fallback, min, max) {
  const n = int(v, fallback);
  return Math.min(max, Math.max(min, n));
}

function mmss(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1e3));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
