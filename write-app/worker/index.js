/**
 * The Drawer — Cloudflare Worker for write.hminv.com
 *
 * Serves the built SPA from the ASSETS binding and a small JSON API backed by D1.
 *
 * Bindings (see wrangler.jsonc):
 *   ASSETS  — static assets from ../dist
 *   DB      — D1 database
 * Secrets:
 *   APP_PASSWORD    — the passphrase that unlocks the app
 *   SESSION_SECRET  — random string used to sign the session cookie
 */

const SESSION_COOKIE = "drawer_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: err?.message || String(err) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

// ---------------------------------------------------------------- routing

async function handleApi(request, env, url) {
  const path = url.pathname.slice("/api".length);
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/session" && method === "GET") {
    return json({ authed: await isAuthed(request, env) });
  }

  if (path === "/login" && method === "POST") {
    return await login(request, env);
  }

  if (path === "/logout" && method === "POST") {
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": clearCookie(url) },
    });
  }

  // Everything past this point requires a session.
  if (!(await isAuthed(request, env))) {
    return json({ error: "unauthorized" }, 401);
  }

  if (path === "/state" && method === "GET") return await loadState(env);

  if (path === "/snippets" && method === "POST") return await createSnippet(request, env);

  if (path === "/snippets/bulk" && method === "POST") return await bulkCreate(request, env);

  const one = path.match(/^\/snippets\/([A-Za-z0-9_-]+)$/);
  if (one && method === "PUT") return await updateSnippet(one[1], request, env);
  if (one && method === "DELETE") return await deleteSnippet(one[1], env);

  if (path === "/tags" && method === "POST") return await createTag(request, env);

  return json({ error: "not found" }, 404);
}

// ------------------------------------------------------------------- auth

async function login(request, env) {
  const { password } = await request.json().catch(() => ({}));
  const expected = env.APP_PASSWORD;

  if (!expected || !env.SESSION_SECRET) {
    return json({ error: "Server is missing APP_PASSWORD or SESSION_SECRET." }, 500);
  }
  if (typeof password !== "string" || !(await timingSafeEqual(password, expected))) {
    // A uniform delay makes password probing less informative.
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: "That passphrase doesn't open this drawer." }, 401);
  }

  const url = new URL(request.url);
  const token = await signSession(env.SESSION_SECRET);
  return new Response(JSON.stringify({ authed: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": sessionCookie(token, url),
    },
  });
}

async function isAuthed(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  return await verifySession(token, env.SESSION_SECRET);
}

async function signSession(secret) {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  const sig = await hmac(exp, secret);
  return `${exp}.${sig}`;
}

async function verifySession(token, secret) {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return timingSafeEqual(sig, await hmac(exp, secret));
}

async function hmac(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64url(sig);
}

function base64url(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Compares SHA-256 digests so the loop always runs over 32 fixed-length bytes,
// leaking neither the length nor the position of the first difference.
async function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function sessionCookie(token, url) {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearCookie(url) {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0`;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ------------------------------------------------------------------- data

async function loadState(env) {
  const [snippetRows, tagRows, linkRows] = await Promise.all([
    env.DB.prepare("SELECT id, body, created_at, updated_at FROM snippets ORDER BY created_at DESC").all(),
    env.DB.prepare("SELECT name FROM tags ORDER BY created_at ASC, name ASC").all(),
    env.DB.prepare("SELECT snippet_id, tag FROM snippet_tags").all(),
  ]);

  const byId = new Map();
  for (const r of snippetRows.results) {
    byId.set(r.id, {
      id: r.id,
      body: r.body,
      tags: [],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  for (const l of linkRows.results) {
    byId.get(l.snippet_id)?.tags.push(l.tag);
  }

  return json({
    snippets: [...byId.values()],
    tags: tagRows.results.map((t) => t.name),
  });
}

async function createSnippet(request, env) {
  const { body, tags } = await request.json().catch(() => ({}));
  const text = String(body || "").trim();
  if (!text) return json({ error: "Snippet is empty." }, 400);

  const snippet = {
    id: crypto.randomUUID(),
    body: text,
    tags: cleanTags(tags),
    createdAt: new Date().toISOString(),
  };
  snippet.updatedAt = snippet.createdAt;

  await env.DB.batch([
    env.DB.prepare("INSERT INTO snippets (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      snippet.id,
      snippet.body,
      snippet.createdAt,
      snippet.updatedAt
    ),
    ...tagStatements(env, snippet.id, snippet.tags, snippet.createdAt),
  ]);

  return json({ snippet });
}

async function bulkCreate(request, env) {
  const { snippets } = await request.json().catch(() => ({}));
  if (!Array.isArray(snippets) || !snippets.length) return json({ error: "Nothing to import." }, 400);

  const now = new Date().toISOString();
  const built = [];
  for (const raw of snippets.slice(0, 5000)) {
    const text = String(raw?.body || "").trim();
    if (!text) continue;
    const createdAt = isoOr(raw?.createdAt, now);
    built.push({
      id: crypto.randomUUID(),
      body: text,
      tags: cleanTags(raw?.tags),
      createdAt,
      updatedAt: createdAt,
    });
  }
  if (!built.length) return json({ error: "Nothing to import." }, 400);

  const statements = [];
  for (const s of built) {
    statements.push(
      env.DB.prepare("INSERT INTO snippets (id, body, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
        s.id,
        s.body,
        s.createdAt,
        s.updatedAt
      ),
      ...tagStatements(env, s.id, s.tags, now)
    );
  }
  // D1 batches are bounded, so send them in chunks.
  for (let i = 0; i < statements.length; i += 100) {
    await env.DB.batch(statements.slice(i, i + 100));
  }

  return json({ snippets: built });
}

async function updateSnippet(id, request, env) {
  const { body, tags } = await request.json().catch(() => ({}));
  const text = String(body || "").trim();
  if (!text) return json({ error: "Snippet is empty." }, 400);

  const existing = await env.DB.prepare("SELECT id FROM snippets WHERE id = ?").bind(id).first();
  if (!existing) return json({ error: "not found" }, 404);

  const updatedAt = new Date().toISOString();
  const nextTags = cleanTags(tags);

  await env.DB.batch([
    env.DB.prepare("UPDATE snippets SET body = ?, updated_at = ? WHERE id = ?").bind(text, updatedAt, id),
    env.DB.prepare("DELETE FROM snippet_tags WHERE snippet_id = ?").bind(id),
    ...tagStatements(env, id, nextTags, updatedAt),
  ]);

  return json({ snippet: { id, body: text, tags: nextTags, updatedAt } });
}

async function deleteSnippet(id, env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM snippet_tags WHERE snippet_id = ?").bind(id),
    env.DB.prepare("DELETE FROM snippets WHERE id = ?").bind(id),
  ]);
  return new Response(null, { status: 204 });
}

async function createTag(request, env) {
  const { name } = await request.json().catch(() => ({}));
  const clean = cleanTags([name]);
  if (!clean.length) return json({ error: "Tag is empty." }, 400);
  await env.DB.prepare("INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)")
    .bind(clean[0], new Date().toISOString())
    .run();
  return json({ tag: clean[0] });
}

// Writing a snippet's tags also registers any tag the app hasn't seen before.
function tagStatements(env, snippetId, tags, now) {
  const out = [];
  for (const tag of tags) {
    out.push(
      env.DB.prepare("INSERT OR IGNORE INTO tags (name, created_at) VALUES (?, ?)").bind(tag, now),
      env.DB.prepare("INSERT OR IGNORE INTO snippet_tags (snippet_id, tag) VALUES (?, ?)").bind(snippetId, tag)
    );
  }
  return out;
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  for (const t of tags) {
    const name = String(t || "").trim().slice(0, 60);
    if (name) seen.add(name);
  }
  return [...seen];
}

function isoOr(value, fallback) {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d.toISOString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
