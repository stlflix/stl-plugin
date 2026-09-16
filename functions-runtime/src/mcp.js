/**
 * The runtime's only way to speak to the MCP server, and it opens exactly two
 * doors (AD-008 of this repo): which credential runs a slug's functions, and
 * what the published bundle of one function is. Everything travels under
 * `X-Runtime-Key`, which does not open `/admin` — so a compromised runtime
 * still cannot provision, exec or mint a token.
 */
export class RuntimeKeyRejected extends Error {
  constructor(status) {
    super(`the MCP server refused the runtime key (${status})`);
    this.name = "RuntimeKeyRejected";
    this.status = status;
  }
}

export class McpUnavailable extends Error {
  constructor(path, status, body) {
    super(`POST ${path} answered ${status}: ${body.slice(0, 200)}`);
    this.name = "McpUnavailable";
    this.status = status;
  }
}

export class McpClient {
  constructor({ baseUrl, runtimeKey, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.runtimeKey = runtimeKey;
    this.fetchImpl = fetchImpl;
  }

  /** 404 is an answer, not a failure: the slug has no execution role yet. */
  async #post(path) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Runtime-Key": this.runtimeKey },
      body: "{}",
    });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) throw new RuntimeKeyRejected(response.status);
    if (!response.ok) throw new McpUnavailable(path, response.status, await response.text());
    return response.json();
  }

  /** `{ database, user: "<slug>_fn", password }` — a role that owns nothing. */
  async credential(slug) {
    return this.#post(`/admin/runtime/credential/${slug}`);
  }

  /** `{ version, bundle, secrets }` of the published version, secrets decrypted. */
  async function(slug, name) {
    return this.#post(`/admin/runtime/function/${slug}/${name}`);
  }
}
