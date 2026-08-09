// Thin wrapper over the worker's JSON API. Every call carries the session cookie.

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    const err = new Error("unauthorized");
    err.unauthorized = true;
    throw err;
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  session: () => call("/session"),
  login: (password) => call("/login", { method: "POST", body: { password } }),
  logout: () => call("/logout", { method: "POST" }),
  state: () => call("/state"),
  createSnippet: (body, tags) => call("/snippets", { method: "POST", body: { body, tags } }),
  updateSnippet: (id, body, tags) => call(`/snippets/${id}`, { method: "PUT", body: { body, tags } }),
  deleteSnippet: (id) => call(`/snippets/${id}`, { method: "DELETE" }),
  bulkCreate: (snippets) => call("/snippets/bulk", { method: "POST", body: { snippets } }),
  createTag: (name) => call("/tags", { method: "POST", body: { name } }),
};
