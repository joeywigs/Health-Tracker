import React, { useState, useEffect, useRef, useMemo } from "react";
import Papa from "papaparse";
import {
  Plus,
  Search,
  Upload,
  Download,
  X,
  Trash2,
  Check,
  ChevronDown,
  Pencil,
  Lock,
} from "lucide-react";
import { api } from "./api.js";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function stamp(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const day = String(d.getDate()).padStart(2, "0");
  return `${day} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export default function WritingApp() {
  const [snippets, setSnippets] = useState([]);
  const [tags, setTags] = useState([]);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  const [body, setBody] = useState("");
  const [composeTags, setComposeTags] = useState([]);
  const [newTag, setNewTag] = useState("");
  const [saving, setSaving] = useState(false);

  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [toast, setToast] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  const flash = (m) => {
    setToast(m);
    window.clearTimeout(flash._t);
    flash._t = window.setTimeout(() => setToast(""), 1800);
  };

  // A failed write means the server and the screen disagree — reload rather than lie.
  const onError = (e) => {
    if (e && e.unauthorized) {
      setAuthed(false);
      return;
    }
    flash(e?.message || "Something went wrong");
    loadState().catch(() => {});
  };

  const loadState = async () => {
    const data = await api.state();
    setSnippets(data.snippets || []);
    setTags(data.tags || []);
  };

  // ---- load ----
  useEffect(() => {
    (async () => {
      try {
        const s = await api.session();
        if (s?.authed) {
          setAuthed(true);
          await loadState();
        }
      } catch (e) {
        if (!e?.unauthorized) flash(e?.message || "Couldn't reach the server");
      }
      setReady(true);
    })();
  }, []);

  const onUnlocked = async () => {
    setAuthed(true);
    try {
      await loadState();
    } catch (e) {
      onError(e);
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setAuthed(false);
    setSnippets([]);
    setTags([]);
    setFilter("all");
    setQuery("");
  };

  // drawers = union of known tags + tags present on snippets, order: known first
  const drawerTags = useMemo(() => {
    const used = new Set();
    snippets.forEach((s) => (s.tags || []).forEach((t) => used.add(t)));
    const out = [...tags];
    used.forEach((t) => { if (!out.includes(t)) out.push(t); });
    return out;
  }, [tags, snippets]);

  const counts = useMemo(() => {
    const c = {};
    snippets.forEach((s) => (s.tags || []).forEach((t) => (c[t] = (c[t] || 0) + 1)));
    return c;
  }, [snippets]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snippets
      .filter((s) => filter === "all" || (s.tags || []).includes(filter))
      .filter((s) => !q || s.body.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [snippets, filter, query]);

  // ---- actions ----
  const addTagToKnown = (name) => {
    const n = name.trim();
    if (!n) return;
    setTags((prev) => (prev.includes(n) ? prev : [...prev, n]));
    api.createTag(n).catch(onError);
  };

  const toggleComposeTag = (t) =>
    setComposeTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const createComposeTag = () => {
    const n = newTag.trim();
    if (!n) return;
    addTagToKnown(n);
    if (!composeTags.includes(n)) setComposeTags((p) => [...p, n]);
    setNewTag("");
  };

  const fileSnippet = async () => {
    if (!body.trim() || saving) return;
    setSaving(true);
    try {
      const { snippet } = await api.createSnippet(body.trim(), composeTags);
      setSnippets((prev) => [snippet, ...prev]);
      setBody("");
      flash("Filed");
      // keep composeTags so several snippets on one theme file quickly
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (id, nextBody, nextTags) => {
    if (!nextBody.trim()) return;
    try {
      const { snippet } = await api.updateSnippet(id, nextBody.trim(), nextTags);
      setSnippets((prev) => prev.map((s) => (s.id === id ? { ...s, ...snippet } : s)));
      setEditingId(null);
      flash("Updated");
    } catch (e) {
      onError(e);
    }
  };

  const removeSnippet = async (id) => {
    try {
      await api.deleteSnippet(id);
      setSnippets((prev) => prev.filter((s) => s.id !== id));
      setEditingId(null);
      flash("Deleted");
    } catch (e) {
      onError(e);
    }
  };

  const exportBackup = () => {
    const blob = new Blob([JSON.stringify({ snippets, tags, exportedAt: new Date().toISOString() }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `writing-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runImport = async (rows) => {
    try {
      const { snippets: created } = await api.bulkCreate(rows);
      setSnippets((prev) => [...created, ...prev]);
      setShowImport(false);
      flash(`Imported ${created.length}`);
    } catch (e) {
      onError(e);
    }
  };

  if (!ready) {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <p className="font-mono text-xs tracking-widest text-stone-400">OPENING…</p>
      </div>
    );
  }

  if (!authed) return <LockScreen onUnlocked={onUnlocked} />;

  return (
    <div className="min-h-screen bg-stone-100 text-stone-900 flex flex-col md:flex-row">
      {/* ---- Rail ---- */}
      <aside className="md:w-64 md:shrink-0 md:h-screen md:sticky md:top-0 border-b md:border-b-0 md:border-r border-stone-300 bg-stone-50 flex flex-col">
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <div>
            <h1 className="font-serif text-xl leading-none text-stone-900">The Drawer</h1>
            <p className="font-mono text-[10px] tracking-[0.2em] text-stone-400 mt-1">
              A PLACE TO WRITE THINGS DOWN
            </p>
          </div>
          <button
            className="md:hidden font-mono text-[10px] tracking-widest text-stone-500 border border-stone-300 rounded px-2 py-1"
            onClick={() => setRailOpen((v) => !v)}
          >
            DRAWERS <ChevronDown className={`inline w-3 h-3 transition-transform ${railOpen ? "rotate-180" : ""}`} />
          </button>
        </div>

        <div className={`${railOpen ? "block" : "hidden"} md:block px-3 flex-1 overflow-y-auto`}>
          <p className="font-mono text-[10px] tracking-[0.2em] text-stone-400 px-2 pt-2 pb-1">DRAWERS</p>
          <DrawerButton
            label="All snippets"
            count={snippets.length}
            active={filter === "all"}
            onClick={() => { setFilter("all"); setRailOpen(false); }}
          />
          {drawerTags.map((t) => (
            <DrawerButton
              key={t}
              label={t}
              count={counts[t] || 0}
              active={filter === t}
              onClick={() => { setFilter(t); setRailOpen(false); }}
            />
          ))}

          <div className="mt-4 mb-2 border-t border-stone-200 pt-3 px-2 space-y-2">
            <button
              onClick={() => setShowImport(true)}
              className="w-full flex items-center gap-2 font-mono text-[11px] tracking-widest text-stone-500 hover:text-emerald-800"
            >
              <Upload className="w-3.5 h-3.5" /> IMPORT CSV
            </button>
            <button
              onClick={exportBackup}
              className="w-full flex items-center gap-2 font-mono text-[11px] tracking-widest text-stone-500 hover:text-emerald-800"
            >
              <Download className="w-3.5 h-3.5" /> EXPORT BACKUP
            </button>
            <button
              onClick={signOut}
              className="w-full flex items-center gap-2 font-mono text-[11px] tracking-widest text-stone-500 hover:text-emerald-800"
            >
              <Lock className="w-3.5 h-3.5" /> LOCK
            </button>
          </div>
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className="flex-1 min-w-0">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
          {/* Compose card — the hero */}
          <section className="bg-white rounded-md shadow-sm border border-stone-200">
            <div className="px-4 sm:px-6 pt-4">
              <p className="font-mono text-[10px] tracking-[0.2em] text-stone-400">NEW SNIPPET</p>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") fileSnippet();
              }}
              placeholder="Start writing. One thought is enough."
              rows={5}
              className="w-full resize-y px-4 sm:px-6 py-3 font-serif text-lg leading-relaxed text-stone-900 placeholder:text-stone-300 focus:outline-none"
            />
            <div className="px-4 sm:px-6 pb-4 pt-1">
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                {drawerTags.map((t) => (
                  <Chip key={t} active={composeTags.includes(t)} onClick={() => toggleComposeTag(t)}>
                    {t}
                  </Chip>
                ))}
                <span className="inline-flex items-center">
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createComposeTag()}
                    placeholder="+ tag"
                    className="w-16 focus:w-28 transition-all font-mono text-[11px] tracking-wide bg-transparent border-b border-dashed border-stone-300 focus:border-emerald-700 focus:outline-none py-0.5 placeholder:text-stone-400"
                  />
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] tracking-widest text-stone-400">
                  {wordCount(body)} {wordCount(body) === 1 ? "WORD" : "WORDS"}
                </span>
                <button
                  onClick={fileSnippet}
                  disabled={!body.trim() || saving}
                  className="inline-flex items-center gap-1.5 rounded bg-emerald-800 text-white font-mono text-[11px] tracking-widest px-4 py-2 disabled:bg-stone-300 disabled:cursor-not-allowed hover:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
                >
                  <Plus className="w-3.5 h-3.5" /> {saving ? "FILING…" : "FILE SNIPPET"}
                </button>
              </div>
            </div>
          </section>

          {/* Search + context */}
          <div className="mt-8 mb-3 flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search snippets"
                className="w-full pl-9 pr-3 py-2 bg-white border border-stone-200 rounded-md font-serif text-sm placeholder:text-stone-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
              />
            </div>
            <span className="font-mono text-[10px] tracking-widest text-stone-400 whitespace-nowrap">
              {filter === "all" ? "ALL" : filter.toUpperCase()} · {visible.length}
            </span>
          </div>

          {/* Tray */}
          {visible.length === 0 ? (
            <div className="mt-16 text-center">
              <p className="font-serif text-lg text-stone-400">
                {snippets.length === 0
                  ? "Nothing filed yet. Write your first snippet above."
                  : "No snippets match this drawer."}
              </p>
            </div>
          ) : (
            <ul className="space-y-3">
              {visible.map((s) =>
                editingId === s.id ? (
                  <EditCard
                    key={s.id}
                    snippet={s}
                    allTags={drawerTags}
                    onSave={saveEdit}
                    onCancel={() => setEditingId(null)}
                    onDelete={removeSnippet}
                    onNewTag={addTagToKnown}
                  />
                ) : (
                  <SnippetCard key={s.id} snippet={s} onEdit={() => setEditingId(s.id)} />
                )
              )}
            </ul>
          )}
        </div>
      </main>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-stone-900 text-white font-mono text-[11px] tracking-widest px-4 py-2 rounded-full shadow-lg">
          {toast.toUpperCase()}
        </div>
      )}

      {showImport && (
        <ImportModal
          knownTags={drawerTags}
          onClose={() => setShowImport(false)}
          onImport={runImport}
          onNewTag={addTagToKnown}
        />
      )}
    </div>
  );
}

function LockScreen({ onUnlocked }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setErr("");
    try {
      await api.login(password);
      onUnlocked();
    } catch (e2) {
      setErr(e2?.unauthorized ? "That passphrase doesn't open this drawer." : e2?.message || "Couldn't sign in");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-stone-100 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="font-serif text-2xl text-stone-900">The Drawer</h1>
        <p className="font-mono text-[10px] tracking-[0.2em] text-stone-400 mt-1 mb-6">
          A PLACE TO WRITE THINGS DOWN
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Passphrase"
          autoFocus
          className="w-full px-4 py-3 bg-white border border-stone-200 rounded-md font-serif text-base placeholder:text-stone-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
        />
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <button
          type="submit"
          disabled={!password || busy}
          className="mt-4 w-full rounded bg-emerald-800 text-white font-mono text-[11px] tracking-widest px-4 py-3 disabled:bg-stone-300 hover:bg-emerald-900"
        >
          {busy ? "OPENING…" : "OPEN"}
        </button>
      </form>
    </div>
  );
}

function DrawerButton({ label, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left transition-colors ${
        active ? "bg-emerald-800 text-white" : "text-stone-700 hover:bg-stone-200"
      }`}
    >
      <span className={`text-sm ${active ? "font-medium" : ""}`}>{label}</span>
      <span className={`font-mono text-[10px] ${active ? "text-emerald-100" : "text-stone-400"}`}>{count}</span>
    </button>
  );
}

function Chip({ children, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-mono text-[10px] tracking-widest px-2.5 py-1 rounded-full border transition-colors ${
        active
          ? "bg-emerald-800 text-white border-emerald-800"
          : "bg-white text-stone-500 border-stone-300 hover:border-stone-400"
      }`}
    >
      {children.toUpperCase()}
    </button>
  );
}

function SnippetCard({ snippet, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const bodyRef = useRef(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [snippet.body]);

  return (
    <li className="bg-white rounded-md border border-stone-200 shadow-sm">
      <div className="px-5 pt-3 flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.2em] text-stone-400">{stamp(snippet.createdAt)}</span>
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-1 font-mono text-[10px] tracking-widest text-stone-400 hover:text-emerald-800"
        >
          <Pencil className="w-3 h-3" /> EDIT
        </button>
      </div>
      <p
        ref={bodyRef}
        className={`px-5 pt-2 font-serif text-[17px] leading-relaxed text-stone-800 whitespace-pre-wrap ${
          expanded ? "" : "line-clamp-2"
        }`}
      >
        {snippet.body}
      </p>
      {(overflows || expanded) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 px-5 inline-flex items-center gap-1 font-mono text-[10px] tracking-widest text-stone-400 hover:text-stone-700"
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          {expanded ? "LESS" : "MORE"}
        </button>
      )}
      {snippet.tags && snippet.tags.length > 0 && (
        <div className="px-5 py-3 flex flex-wrap gap-1.5">
          {snippet.tags.map((t) => (
            <span
              key={t}
              className="font-mono text-[9px] tracking-widest text-stone-500 bg-stone-100 rounded-full px-2 py-0.5"
            >
              {t.toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {(!snippet.tags || snippet.tags.length === 0) && <div className="pb-3" />}
    </li>
  );
}

function EditCard({ snippet, allTags, onSave, onCancel, onDelete, onNewTag }) {
  const [body, setBody] = useState(snippet.body);
  const [tags, setTags] = useState(snippet.tags || []);
  const [newTag, setNewTag] = useState("");
  const toggle = (t) => setTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const create = () => {
    const n = newTag.trim();
    if (!n) return;
    onNewTag(n);
    if (!tags.includes(n)) setTags((p) => [...p, n]);
    setNewTag("");
  };
  return (
    <li className="bg-white rounded-md border border-emerald-700 shadow-sm">
      <div className="px-5 pt-3 font-mono text-[10px] tracking-[0.2em] text-stone-400">
        {stamp(snippet.createdAt)}
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={Math.max(3, Math.ceil(body.length / 60))}
        className="w-full resize-y px-5 py-2 font-serif text-[17px] leading-relaxed focus:outline-none"
      />
      <div className="px-5 pb-2 flex flex-wrap items-center gap-1.5">
        {allTags.map((t) => (
          <Chip key={t} active={tags.includes(t)} onClick={() => toggle(t)}>
            {t}
          </Chip>
        ))}
        <input
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="+ tag"
          className="w-16 focus:w-28 transition-all font-mono text-[11px] bg-transparent border-b border-dashed border-stone-300 focus:border-emerald-700 focus:outline-none py-0.5 placeholder:text-stone-400"
        />
      </div>
      <div className="px-5 py-3 border-t border-stone-100 flex items-center justify-between">
        <button
          onClick={() => onDelete(snippet.id)}
          className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-widest text-red-600 hover:text-red-700"
        >
          <Trash2 className="w-3.5 h-3.5" /> DELETE
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="font-mono text-[11px] tracking-widest text-stone-500 px-3 py-2 hover:text-stone-800"
          >
            CANCEL
          </button>
          <button
            onClick={() => onSave(snippet.id, body, tags)}
            className="inline-flex items-center gap-1.5 rounded bg-emerald-800 text-white font-mono text-[11px] tracking-widest px-4 py-2 hover:bg-emerald-900"
          >
            <Check className="w-3.5 h-3.5" /> SAVE
          </button>
        </div>
      </div>
    </li>
  );
}

function ImportModal({ knownTags, onClose, onImport, onNewTag }) {
  const [rows, setRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [textCol, setTextCol] = useState("");
  const [dateCol, setDateCol] = useState("");
  const [tags, setTags] = useState([]);
  const [newTag, setNewTag] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const guessCols = (hdrs, data) => {
    const textGuess =
      hdrs.find((h) => /body|content|note|text|snippet|message|subject|entry/i.test(h)) ||
      hdrs
        .map((h) => ({ h, len: data.reduce((a, r) => a + (r[h]?.length || 0), 0) }))
        .sort((a, b) => b.len - a.len)[0]?.h ||
      hdrs[0] ||
      "";
    const dateGuess = hdrs.find((h) => /date|time|sent|created|received/i.test(h)) || "";
    setTextCol(textGuess);
    setDateCol(dateGuess);
  };

  const parse = (text) => {
    setErr("");
    const res = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (!res.data || !res.data.length) {
      setErr("No rows found in that CSV.");
      setRows([]);
      return;
    }
    const hdrs = res.meta.fields || Object.keys(res.data[0]);
    setHeaders(hdrs);
    setRows(res.data);
    guessCols(hdrs, res.data);
  };

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => parse(String(reader.result));
    reader.readAsText(f);
  };

  const toggle = (t) => setTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const create = () => {
    const n = newTag.trim();
    if (!n) return;
    onNewTag(n);
    if (!tags.includes(n)) setTags((p) => [...p, n]);
    setNewTag("");
  };

  const doImport = async () => {
    const built = rows
      .map((r) => {
        const bodyText = (r[textCol] || "").trim();
        if (!bodyText) return null;
        let created = new Date().toISOString();
        if (dateCol && r[dateCol]) {
          const d = new Date(r[dateCol]);
          if (!isNaN(d)) created = d.toISOString();
        }
        return { body: bodyText, tags: [...tags], createdAt: created };
      })
      .filter(Boolean);
    if (!built.length) {
      setErr("No usable rows — check the text column.");
      return;
    }
    setBusy(true);
    await onImport(built);
    setBusy(false);
  };

  const usable = rows.filter((r) => (r[textCol] || "").trim()).length;

  return (
    <div className="fixed inset-0 bg-stone-900/40 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
          <div>
            <h2 className="font-serif text-lg">Import from CSV</h2>
            <p className="font-mono text-[10px] tracking-widest text-stone-400 mt-0.5">
              EACH ROW BECOMES A SNIPPET
            </p>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          <div>
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full border-2 border-dashed border-stone-300 rounded-md py-6 text-center hover:border-emerald-700 transition-colors"
            >
              <Upload className="w-5 h-5 mx-auto text-stone-400 mb-1" />
              <span className="font-mono text-[11px] tracking-widest text-stone-500">CHOOSE A CSV FILE</span>
            </button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
            <details className="mt-2">
              <summary className="font-mono text-[10px] tracking-widest text-stone-400 cursor-pointer">
                OR PASTE CSV TEXT
              </summary>
              <textarea
                onChange={(e) => e.target.value.trim() && parse(e.target.value)}
                rows={4}
                placeholder="date,subject&#10;2025-01-04,The thing I remembered…"
                className="mt-2 w-full border border-stone-200 rounded p-2 font-mono text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
              />
            </details>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}

          {rows.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="font-mono text-[10px] tracking-widest text-stone-400">TEXT COLUMN</span>
                  <select
                    value={textCol}
                    onChange={(e) => setTextCol(e.target.value)}
                    className="mt-1 w-full border border-stone-300 rounded px-2 py-1.5 text-sm bg-white"
                  >
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="font-mono text-[10px] tracking-widest text-stone-400">DATE COLUMN</span>
                  <select
                    value={dateCol}
                    onChange={(e) => setDateCol(e.target.value)}
                    className="mt-1 w-full border border-stone-300 rounded px-2 py-1.5 text-sm bg-white"
                  >
                    <option value="">Use today’s date</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div>
                <span className="font-mono text-[10px] tracking-widest text-stone-400">
                  TAG THIS BATCH
                </span>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {knownTags.map((t) => (
                    <Chip key={t} active={tags.includes(t)} onClick={() => toggle(t)}>
                      {t}
                    </Chip>
                  ))}
                  <input
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && create()}
                    placeholder="+ new tag"
                    className="w-24 font-mono text-[11px] bg-transparent border-b border-dashed border-stone-300 focus:border-emerald-700 focus:outline-none py-0.5 placeholder:text-stone-400"
                  />
                </div>
              </div>

              {textCol && rows[0] && (
                <div className="bg-stone-50 rounded p-3 border border-stone-200">
                  <p className="font-mono text-[10px] tracking-widest text-stone-400 mb-1">PREVIEW</p>
                  <p className="font-serif text-sm text-stone-700 line-clamp-3">
                    {(rows[0][textCol] || "").trim() || "—"}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-stone-200 flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-widest text-stone-400">
            {rows.length > 0 ? `${usable} SNIPPETS READY` : "NO FILE YET"}
          </span>
          <button
            onClick={doImport}
            disabled={!usable || busy}
            className="rounded bg-emerald-800 text-white font-mono text-[11px] tracking-widest px-5 py-2 disabled:bg-stone-300 hover:bg-emerald-900"
          >
            {busy ? "IMPORTING…" : "IMPORT"}
          </button>
        </div>
      </div>
    </div>
  );
}
