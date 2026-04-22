import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { generatePKCE } from "@openauthjs/openauth/pkce";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const TIMEOUT = 5 * 60 * 1000;
const REQUIRED_BETAS = [
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
] as const;
const TOOL_PREFIX = "mcp_";
const OPENCODE_IDENTITY_PREFIX = "You are OpenCode";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
] as const;
const TEXT_REPLACEMENTS: Array<{ match: string; replacement: string }> = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
];
const CLAUDE_CODE_VERSION = "2.1.87";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_SALT = "59cf53e54c78";
const CCH_POSITIONS = [4, 7, 20] as const;
const REQUEST_USER_AGENT = "claude-cli/2.1.87 (external, cli)";
const TOKEN_USER_AGENT = "axios/1.13.6";
const DEFAULT_EXTRA_MODELS: Record<string, ExtraModel> = {
  "claude-opus-4-7": {
    name: "Claude Opus 4.7",
  },
};

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

type ExtraModel = {
  id?: string;
  name?: string;
  [k: string]: unknown;
};

type PluginOptions = {
  extraModels?: Record<string, ExtraModel>;
};

type SystemBlock = { type: string; text: string; [k: string]: unknown };
type Message = {
  role?: string;
  content?: string | Array<{ type?: string; text?: string; [k: string]: unknown }>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
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
    let timer: NodeJS.Timeout | undefined;

    const end = (value: string | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      server.close();
      settle(value);
    };

    let settle: (value: string | null) => void = () => {};
    const wait = new Promise<string | null>((resolveWait) => {
      settle = resolveWait;
    });

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
    instructions: "Paste the authorization code here:",
    method: "code" as const,
    callback: async (code: string): Promise<OAuthCredentials | AuthFailure> =>
      exchange(code, pkce.verifier, CALLBACK_URL, state),
  };
}

function makeTokenHeaders(): HeadersInit {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": TOKEN_USER_AGENT,
  };
}

function makeTokenBody(params: Record<string, string>): string {
  return JSON.stringify(params);
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
    headers: makeTokenHeaders(),
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
  const paragraphs = text.split(/\n\n+/);

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      return false;
    }

    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }

    return true;
  });

  let result = filtered.join("\n\n");

  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement);
  }

  return result.trim();
}

function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY,
  };

  if (system == null) return [identityBlock];

  if (typeof system === "string") {
    const sanitized = sanitizeSystemText(system);
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock];
    return [identityBlock, { type: "text", text: sanitized }];
  }

  if (isRecord(system)) {
    const type = typeof system.type === "string" ? system.type : "text";
    const text = typeof system.text === "string" ? system.text : "";
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }];
  }

  if (!Array.isArray(system)) return [identityBlock];

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === "string") {
      return { type: "text", text: sanitizeSystemText(item) };
    }

    if (
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      return {
        ...item,
        type: "text",
        text: sanitizeSystemText(item.text),
      };
    }

    return { type: "text", text: String(item) };
  });

  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized;
  }

  return [identityBlock, ...sanitized];
}

function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function unprefixName(name: string): string {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

function prefixToolNames(parsed: Record<string, unknown>): string {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }),
    );
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{
          type: string;
          name?: string;
          [k: string]: unknown;
        }>;
        [k: string]: unknown;
      }) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === "tool_use" && block.name) {
              return { ...block, name: prefixName(block.name) };
            }
            return block;
          });
        }
        return msg;
      },
    );
  }

  return JSON.stringify(parsed);
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

function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(",");
}

function setOAuthHeaders(headers: Headers, accessToken: string): Headers {
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", mergeBetaHeaders(headers));
  headers.set("user-agent", REQUEST_USER_AGENT);
  headers.delete("x-api-key");
  return headers;
}

function rewriteUrl(input: RequestInfo | URL): RequestInfo | URL {
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

function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((message) => message.role === "user");
  if (!userMsg) return "";

  const { content } = userMsg;
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block.type === "text");
    if (textBlock?.text) return textBlock.text;
  }

  return "";
}

function computeCCH(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

function computeVersionSuffix(messageText: string): string {
  const chars = CCH_POSITIONS.map((index) => messageText[index] || "0").join("");

  return createHash("sha256")
    .update(`${CCH_SALT}${chars}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
}

function buildBillingHeaderValue(messages: Message[]): string {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text);
  const cch = computeCCH(text);

  return (
    `${BILLING_HEADER_PREFIX} ` +
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT}; ` +
    `cch=${cch};`
  );
}

function relocateSystemEntriesToFirstUserMessage(
  system: unknown,
  messages: Message[] | undefined,
): unknown {
  if (!Array.isArray(system) || !Array.isArray(messages)) return system;

  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) return system;

  const kept: SystemBlock[] = [];
  const moved: string[] = [];

  for (const entry of system) {
    if (isRecord(entry) && typeof entry.text === "string") {
      const text = entry.text.trim();
      if (!text) continue;

      if (
        text.startsWith(BILLING_HEADER_PREFIX) ||
        text === CLAUDE_CODE_IDENTITY
      ) {
        kept.push({ type: "text", text });
      } else {
        moved.push(text);
      }

      continue;
    }

    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) moved.push(text);
    }
  }

  if (!moved.length) return kept;

  const relocatedText = moved.join("\n\n");

  if (typeof firstUserMessage.content === "string") {
    firstUserMessage.content = firstUserMessage.content
      ? `${relocatedText}\n\n${firstUserMessage.content}`
      : relocatedText;
  } else if (Array.isArray(firstUserMessage.content)) {
    firstUserMessage.content = [
      { type: "text", text: relocatedText },
      ...firstUserMessage.content,
    ];
  } else {
    firstUserMessage.content = relocatedText;
  }

  return kept;
}

function normalizeExtraModels(input: unknown): Record<string, ExtraModel> {
  if (!isRecord(input)) return {};

  const extraModels: Record<string, ExtraModel> = {};

  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) continue;

    const id = trim(value.id) || key;
    const name = trim(value.name) || id;
    extraModels[key] = {
      ...value,
      id,
      name,
    };
  }

  return extraModels;
}

function resolveExtraModels(options: unknown): Record<string, ExtraModel> {
  const extraModels = isRecord(options) ? options.extraModels : undefined;

  return {
    ...normalizeExtraModels(DEFAULT_EXTRA_MODELS),
    ...normalizeExtraModels(extraModels),
  };
}

function rewriteRequestBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (!body || typeof body !== "string") return body;

  try {
    const parsed = JSON.parse(body) as {
      system?: unknown;
      tools?: Array<{ name?: string } & Record<string, unknown>>;
      messages?: Message[];
    };

    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some((message) => message.role === "user")
        ? buildBillingHeaderValue(parsed.messages)
        : null;

    parsed.system = prependClaudeCodeIdentity(parsed.system);

    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: "text", text: billingHeader });
    }

    parsed.system = relocateSystemEntriesToFirstUserMessage(
      parsed.system,
      parsed.messages,
    );

    return prefixToolNames(parsed as Record<string, unknown>);
  } catch {
    return body;
  }
}

function rewriteResponse(response: Response): Response {
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
      text = text.replace(
        /"name"\s*:\s*"mcp_([^"]+)"/g,
        (_match, name: string) => `"name": "${unprefixName(name)}"`,
      );
      controller.enqueue(encoder.encode(text));
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const AnthropicAuthPlugin = (async (
  { client }: PluginInput,
  options?: PluginOptions,
) => {
  const authClient = client as unknown as AuthSetter;
  const extraModels = resolveExtraModels(options);

  return {
    auth: {
      provider: "anthropic",
      loader: (async (getAuth: () => Promise<unknown>, provider: any) => {
        const auth = await getAuth();
        if (isOAuthAuth(auth)) {
          provider.models ||= {};

          for (const [id, model] of Object.entries(extraModels)) {
            provider.models[id] ||= model;
          }

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
                    const maxRetries = 2;
                    const baseDelayMs = 500;

                    for (let attempt = 0; attempt <= maxRetries; attempt++) {
                      try {
                        if (attempt > 0) {
                          const delay = baseDelayMs * 2 ** (attempt - 1);
                          await new Promise((resolve) => setTimeout(resolve, delay));
                        }

                        const response = await fetch(TOKEN_URL, {
                          method: "POST",
                          headers: makeTokenHeaders(),
                          body: makeTokenBody({
                            grant_type: "refresh_token",
                            refresh_token: auth.refresh,
                            client_id: CLIENT_ID,
                          }),
                        });

                        if (!response.ok) {
                          if (response.status >= 500 && attempt < maxRetries) {
                            await response.body?.cancel();
                            continue;
                          }

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

                        return json.access_token;
                      } catch (error) {
                        const isNetworkError =
                          error instanceof Error &&
                          (error.message.includes("fetch failed") ||
                            ("code" in error &&
                              (error.code === "ECONNRESET" ||
                                error.code === "ECONNREFUSED" ||
                                error.code === "ETIMEDOUT" ||
                                error.code === "UND_ERR_CONNECT_TIMEOUT")));

                        if (attempt < maxRetries && isNetworkError) {
                          continue;
                        }

                        throw error;
                      }
                    }

                    throw new Error("Token refresh exhausted all retries");
                  })().finally(() => {
                    refreshPromise = null;
                  });
                }

                auth.access = await refreshPromise;
              }

              const requestInit: RequestInit = init ?? {};
              const headers = mergeHeaders(input, requestInit);
              setOAuthHeaders(headers, auth.access);
              const body = rewriteRequestBody(requestInit.body);
              const requestInput = rewriteUrl(input);

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
