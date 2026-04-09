import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePKCE } from "@openauthjs/openauth/pkce";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const TIMEOUT = 5 * 60 * 1000;
const ANTHROPIC_VERSION = "2023-06-01";
const APP_ID = "cli";
const CLAUDE_CODE_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const CLAUDE_CODE_FALLBACK = "2.1.96";
const REQUIRED_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
] as const;
const TOOL_PREFIX = "mcp_";
const SESSION_ID = crypto.randomUUID();

const DEVICE_ID_PATH = join(homedir(), ".local", "share", "opencode", ".anthropic_device_id");
const DEVICE_ID = (() => {
  try {
    if (existsSync(DEVICE_ID_PATH)) {
      const existing = readFileSync(DEVICE_ID_PATH, "utf8").trim();
      if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(existing)) {
        return existing;
      }
    }
  } catch {}

  const id = crypto.randomUUID();
  try {
    mkdirSync(join(DEVICE_ID_PATH, ".."), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, id, "utf8");
  } catch {}
  return id;
})();

const OPENCODE_IDENTITY = "You are OpenCode, the best coding agent on the planet.";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
] as const;
const TEXT_REPLACEMENTS: Array<{ match: string; replacement: string }> = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
];

let cachedUserAgent: string | undefined;
let pendingUserAgent: Promise<string> | undefined;

type Mode = "max" | "console";

type ParsedCode = {
  code: string;
  state: string;
};

type AuthFailure = {
  type: "failed";
};

type OAuthCredentials = {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
};

type ApiKeyCredentials = {
  type: "success";
  key: string;
};

type OAuthAuth = {
  type: "oauth";
  refresh: string;
  access?: string;
  expires: number;
};

type LocalAuthorization = {
  redirect: string;
  wait: () => Promise<string | null>;
};

type AuthSetter = {
  auth: {
    set(input: {
      path: { id: string };
      body: OAuthAuth;
    }): Promise<void>;
  };
};

function isOAuthAuth(value: unknown): value is OAuthAuth {
  if (!value || typeof value !== "object") return false;

  const auth = value as Partial<OAuthAuth>;
  return (
    auth.type === "oauth" &&
    typeof auth.refresh === "string" &&
    typeof auth.expires === "number"
  );
}

function trim(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function userAgentFromVersion(version: string): string {
  const value = trim(version);
  if (!value) return "";
  return `claude-code/${value}`;
}

async function fetchRegistryVersion(): Promise<string> {
  const channel = trim(process.env.OP_ANTHROPIC_AUTH_CLAUDE_CODE_CHANNEL) || "latest";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(CLAUDE_CODE_URL, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Registry lookup failed: ${response.status}`);
    }

    const body = (await response.json()) as {
      "dist-tags"?: Record<string, unknown>;
    };
    const version = trim(body["dist-tags"]?.[channel]);
    if (!version) {
      throw new Error(`Missing dist-tag: ${channel}`);
    }

    return version;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveUserAgent(): Promise<string> {
  const forcedUserAgent = trim(process.env.OP_ANTHROPIC_AUTH_USER_AGENT);
  if (forcedUserAgent) return forcedUserAgent;

  const forcedVersion = trim(process.env.OP_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION);
  if (forcedVersion) return userAgentFromVersion(forcedVersion);

  if (cachedUserAgent) return cachedUserAgent;
  if (pendingUserAgent) return pendingUserAgent;

  pendingUserAgent = (async () => {
    try {
      cachedUserAgent = userAgentFromVersion(await fetchRegistryVersion());
    } catch {
      cachedUserAgent = userAgentFromVersion(CLAUDE_CODE_FALLBACK);
    }

    return cachedUserAgent;
  })();

  try {
    return await pendingUserAgent;
  } finally {
    pendingUserAgent = undefined;
  }
}

function makeState(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function makePage(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Authorization complete</title></head>
  <body>
    <h1>Authorization complete</h1>
    <p>You can close this window and return to OpenCode.</p>
  </body>
</html>`;
}

function parse(input: string): ParsedCode | null {
  const text = input.trim();

  try {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return { code, state };
  } catch {
    // Ignore non-URL input and try the alternate formats below.
  }

  const split = text.split("#");
  if (split.length === 2 && split[0] && split[1]) {
    return { code: split[0], state: split[1] };
  }

  const params = new URLSearchParams(text);
  const code = params.get("code");
  const state = params.get("state");
  if (code && state) return { code, state };
  return null;
}

function makeUrl(
  mode: Mode,
  challenge: string,
  state: string,
  redirect: string,
): string {
  const host = mode === "console" ? "platform.claude.com" : "claude.ai";
  const url = new URL(`https://${host}/oauth/authorize`);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set(
    "scope",
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  );
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

async function local(state: string): Promise<LocalAuthorization> {
  const server = createServer();

  return new Promise((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete!: (value: string | null) => void;
    const wait = new Promise<string | null>((innerResolve) => {
      complete = innerResolve;
    });

    const end = (value: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (server.listening) {
        server.close(() => complete(value));
        return;
      }
      complete(value);
    };

    server.on("request", (req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );

      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const got = url.searchParams.get("state");
      if (!code || !got) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing code or state");
        return;
      }

      if (got !== state) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid state");
        end(null);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(makePage());
      end(url.toString());
    });

    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate localhost callback port"));
        return;
      }

      timer = setTimeout(() => end(null), TIMEOUT);
      resolve({
        redirect: `http://localhost:${address.port}/callback`,
        wait: () => wait,
      });
    });
  });
}

async function authorize(mode: Mode) {
  const pkce = await generatePKCE();
  const state = makeState();

  try {
    const info = await local(state);
    return {
      url: makeUrl(mode, pkce.challenge, state, info.redirect),
      instructions: "Complete authorization in the browser.",
      method: "auto" as const,
      callback: async (): Promise<OAuthCredentials | AuthFailure> => {
        const input = await info.wait();
        if (!input) return { type: "failed" };
        return exchange(input, pkce.verifier, info.redirect, state);
      },
    };
  } catch {
    // Fall back to manual code entry when localhost callback setup fails.
  }

  return {
    url: makeUrl(mode, pkce.challenge, state, CALLBACK_URL),
    instructions: "Paste the authorization code here: ",
    method: "code" as const,
    callback: async (code: string): Promise<OAuthCredentials | AuthFailure> =>
      exchange(code, pkce.verifier, CALLBACK_URL, state),
  };
}

function makeTokenHeaders(userAgent: string): HeadersInit {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": userAgent,
  };
}

function makeTokenBody(params: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.set(key, value);
  }
  return body.toString();
}

async function exchange(
  input: string,
  verifier: string,
  redirect: string,
  expected: string,
): Promise<OAuthCredentials | AuthFailure> {
  const parsed = parse(input);
  if (!parsed) return { type: "failed" };
  if (parsed.state !== expected) return { type: "failed" };

  const userAgent = await resolveUserAgent();
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: makeTokenHeaders(userAgent),
    body: makeTokenBody({
      code: parsed.code,
      state: parsed.state,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  });

  if (!result.ok) return { type: "failed" };

  const json = (await result.json()) as {
    refresh_token: string;
    access_token: string;
    expires_in: number;
  };

  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

function sanitizeSystemText(text: string): string {
  if (!text.includes(OPENCODE_IDENTITY)) return text;

  const paragraphs = text.split(/\n\n+/);
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY) && paragraph.trim() === OPENCODE_IDENTITY) {
      return false;
    }

    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }

    return true;
  });

  let result = filtered.join("\n\n");
  result = result.replace(OPENCODE_IDENTITY, "").replace(/\n{3,}/g, "\n\n");

  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement);
  }

  result = result
    .replace(/\bOpenCode\b/g, "Claude Code")
    .replace(/\bopencode\b/gi, "Claude");

  return result.trim();
}

function prependClaudeCodeIdentity(system: unknown): Array<{ type: string; text: string } & Record<string, unknown>> {
  const identityBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY,
  };

  if (system == null) return [identityBlock];

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock];
    return [identityBlock, { type: "text", text: sanitized }];
  }

  if (!Array.isArray(system) && typeof system === "object") {
    const record = system as Record<string, unknown>;
    return [
      identityBlock,
      {
        ...record,
        type: typeof record.type === "string" ? record.type : "text",
        text: sanitizeSystemText(typeof record.text === "string" ? record.text : ""),
      },
    ];
  }

  if (!Array.isArray(system)) return [identityBlock];

  const sanitized = system.map((item) => {
    if (typeof item === "string") {
      return { type: "text", text: sanitizeSystemText(item) };
    }

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return {
        ...record,
        type: record.type === "text" ? "text" : typeof record.type === "string" ? record.type : "text",
        text: sanitizeSystemText(typeof record.text === "string" ? record.text : ""),
      };
    }

    return { type: "text", text: String(item) };
  });

  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized;
  }

  return [identityBlock, ...sanitized];
}

function rewriteRequestBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!body || typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body) as {
      system?: unknown;
      tools?: Array<{ name?: string } & Record<string, unknown>>;
      messages?: Array<{
        role?: string;
        content?: string | Array<{ type?: string; name?: string; text?: string } & Record<string, unknown>>;
      }>;
      metadata?: { user_id?: string };
    };

    if (!parsed.metadata) parsed.metadata = {};
    if (!parsed.metadata.user_id) {
      parsed.metadata.user_id = JSON.stringify({
        device_id: DEVICE_ID,
        account_uuid: "",
        session_id: SESSION_ID,
      });
    }

    parsed.system = prependClaudeCodeIdentity(parsed.system);

    if (Array.isArray(parsed.system) && parsed.system.length > 1) {
      const kept = [parsed.system[0]];
      const movedTexts: string[] = [];

      for (let i = 1; i < parsed.system.length; i++) {
        const entry = parsed.system[i] as { text?: string } | string;
        const text = typeof entry === "string" ? entry : trim(entry?.text);
        if (text) movedTexts.push(text);
      }

      if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
        const firstUser = parsed.messages.find((message) => message.role === "user");
        if (firstUser) {
          parsed.system = kept;
          const prefix = movedTexts.join("\n\n");

          if (typeof firstUser.content === "string") {
            firstUser.content = `${prefix}\n\n${firstUser.content}`;
          } else if (Array.isArray(firstUser.content)) {
            firstUser.content.unshift({ type: "text", text: prefix });
          }
        }
      }
    }

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }));
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (Array.isArray(message.content)) {
          return {
            ...message,
            content: message.content.map((block) => {
              if (block.type === "tool_use" && block.name) {
                return {
                  ...block,
                  name: `${TOOL_PREFIX}${block.name}`,
                };
              }
              return block;
            }),
          };
        }
        return message;
      });
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function mergeHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  const initHeaders = init?.headers;
  if (initHeaders instanceof Headers) {
    initHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  } else if (initHeaders) {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  }

  return headers;
}

function setOAuthHeaders(headers: Headers, auth: OAuthAuth, userAgent: string): Headers {
  const incomingBeta = headers.get("anthropic-beta") ?? "";
  const betas = incomingBeta
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);

  headers.set("authorization", `Bearer ${auth.access}`);
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("anthropic-beta", [...new Set([...REQUIRED_BETAS, ...betas])].join(","));
  headers.set("x-app", APP_ID);
  headers.set("x-request-id", crypto.randomUUID());
  headers.set("user-agent", userAgent);
  headers.delete("x-api-key");

  return headers;
}

function withMessagesBeta(input: RequestInfo | URL): RequestInfo | URL {
  let requestUrl: URL | null = null;

  try {
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    }
  } catch {
    requestUrl = null;
  }

  if (
    requestUrl &&
    requestUrl.pathname === "/v1/messages" &&
    !requestUrl.searchParams.has("beta")
  ) {
    requestUrl.searchParams.set("beta", "true");
    return input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl;
  }

  return input;
}

async function rewriteResponse(response: Response): Promise<Response> {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      let text = decoder.decode(value, { stream: true });
      text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
      controller.enqueue(encoder.encode(text));
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const AnthropicAuthPlugin = (async ({ client }: PluginInput) => {
  const authClient = client as unknown as AuthSetter;

  return {
    "experimental.chat.system.transform": (input: any, output: any) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
      }
    },
    auth: {
      provider: "anthropic",
      loader: (async (getAuth: () => Promise<unknown>, provider: any) => {
        const auth = await getAuth();
        if (isOAuthAuth(auth)) {
          const userAgent = await resolveUserAgent();

          for (const model of Object.values(provider.models) as Array<any>) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            };
          }

          let refreshPromise: Promise<string> | null = null;

          return {
            apiKey: "",
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const auth = await getAuth();
              if (!isOAuthAuth(auth)) return fetch(input, init);

              if (!auth.access || auth.expires < Date.now()) {
                if (!refreshPromise) {
                  refreshPromise = (async () => {
                    const response = await fetch(TOKEN_URL, {
                      method: "POST",
                      headers: makeTokenHeaders(userAgent),
                      body: makeTokenBody({
                        grant_type: "refresh_token",
                        refresh_token: auth.refresh,
                        client_id: CLIENT_ID,
                      }),
                    });

                    if (!response.ok) {
                      const body = await response.text().catch(() => "");
                      throw new Error(`Token refresh failed: ${response.status} — ${body}`);
                    }

                    const json = (await response.json()) as {
                      refresh_token: string;
                      access_token: string;
                      expires_in: number;
                    };

                    await authClient.auth.set({
                      path: {
                        id: "anthropic",
                      },
                      body: {
                        type: "oauth",
                        refresh: json.refresh_token,
                        access: json.access_token,
                        expires: Date.now() + json.expires_in * 1000,
                      },
                    });

                    auth.access = json.access_token;
                    auth.expires = Date.now() + json.expires_in * 1000;
                    auth.refresh = json.refresh_token;
                    return json.access_token;
                  })().finally(() => {
                    refreshPromise = null;
                  });
                }

                auth.access = await refreshPromise;
              }

              const requestInit: RequestInit = init ?? {};
              const headers = mergeHeaders(input, requestInit);
              setOAuthHeaders(headers, auth, userAgent);
              const body = rewriteRequestBody(requestInit.body);
              const requestInput = withMessagesBeta(input);

              const response = await fetch(requestInput, {
                ...requestInit,
                body,
                headers,
              });

              return rewriteResponse(response);
            },
          };
        }

        return {};
      }) as any,
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => authorize("max"),
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const auth = await authorize("console");
            return {
              url: auth.url,
              instructions: auth.instructions,
              method: auth.method,
              callback: async (code?: string): Promise<ApiKeyCredentials | AuthFailure> => {
                const credentials = await auth.callback(code as string);
                if (credentials.type === "failed") return credentials;

                const result = (await fetch(
                  "https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((response) => response.json())) as { raw_key: string };

                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}) as unknown as Plugin;

export default AnthropicAuthPlugin;
