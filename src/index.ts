import { createServer } from "node:http";
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

async function exchange(
  input: string,
  verifier: string,
  redirect: string,
  expected: string,
): Promise<OAuthCredentials | AuthFailure> {
  const parsed = parse(input);
  if (!parsed) return { type: "failed" };
  if (parsed.state !== expected) return { type: "failed" };

  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "axios/1.13.6",
    },
    body: JSON.stringify({
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

function rewriteRequestBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!body || typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body) as {
      system?: Array<{ type?: string; text?: string }>;
      tools?: Array<{ name?: string } & Record<string, unknown>>;
      messages?: Array<{
        content?: Array<{ type?: string; name?: string } & Record<string, unknown>>;
      }>;
    };

    if (Array.isArray(parsed.system)) {
      parsed.system = parsed.system.map((item) => {
        if (item.type === "text" && item.text) {
          return {
            ...item,
            text: item.text
              .replace(/OpenCode/g, "Claude Code")
              .replace(/opencode/gi, "Claude"),
          };
        }
        return item;
      });
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

function mergeHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  auth: OAuthAuth,
): Headers {
  const headers = new Headers();

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  }

  const incomingBeta = headers.get("anthropic-beta") ?? "";
  const betas = incomingBeta
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);

  headers.set("authorization", `Bearer ${auth.access}`);
  headers.set("anthropic-version", ANTHROPIC_VERSION);
  headers.set("anthropic-beta", [...new Set([...REQUIRED_BETAS, ...betas])].join(","));
  headers.set("x-app", APP_ID);
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
        if (output.system[1]) {
          output.system[1] = `${prefix}\n\n${output.system[1]}`;
        }
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

          return {
            apiKey: "",
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const auth = await getAuth();
              if (!isOAuthAuth(auth)) return fetch(input, init);

              if (!auth.access || auth.expires < Date.now()) {
                const response = await fetch(TOKEN_URL, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "axios/1.13.6",
                  },
                  body: JSON.stringify({
                    grant_type: "refresh_token",
                    refresh_token: auth.refresh,
                    client_id: CLIENT_ID,
                  }),
                });

                if (!response.ok) {
                  throw new Error(`Token refresh failed: ${response.status}`);
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
              }

              const requestInit: RequestInit = init ?? {};
              const headers = mergeHeaders(input, requestInit, auth);
              headers.set("user-agent", userAgent);
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
