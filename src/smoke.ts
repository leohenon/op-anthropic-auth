import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const MESSAGE_URL = "https://api.anthropic.com/v1/messages?beta=true";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_VERSION = "2023-06-01";
const APP_ID = "cli";
const CLAUDE_CODE_FALLBACK = "2.1.96";
const DEVICE_ID = crypto.randomUUID();

type StoredAuthFile = {
  anthropic?: {
    access?: string;
  };
};

function fail(message: string): never {
  console.error(`smoke failed: ${message}`);
  process.exit(1);
}

function readAuth(): StoredAuthFile {
  try {
    return JSON.parse(
      readFileSync(path.join(homedir(), ".local/share/opencode/auth.json"), "utf8"),
    ) as StoredAuthFile;
  } catch {
    return {};
  }
}

function trim(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

const userAgent =
  trim(process.env.OP_ANTHROPIC_AUTH_USER_AGENT) ||
  `claude-code/${trim(process.env.OP_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION) || CLAUDE_CODE_FALLBACK}`;

const model = process.env.ANTHROPIC_SMOKE_MODEL || "claude-3-haiku-20240307";
const refreshMode = process.env.ANTHROPIC_SMOKE_REFRESH === "1";
const auth = readAuth();

let access = process.env.ANTHROPIC_ACCESS_TOKEN || auth.anthropic?.access;

if (refreshMode) {
  const refresh = process.env.ANTHROPIC_REFRESH_TOKEN;
  if (!refresh) {
    fail("missing ANTHROPIC_REFRESH_TOKEN for refresh mode");
  }

  const token = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!token.ok) {
    const body = await token.text();
    fail(`token refresh ${token.status}: ${body.slice(0, 500)}`);
  }

  const json = (await token.json()) as { access_token?: string };
  if (!json.access_token) {
    fail("token refresh returned no access_token");
  }

  access = json.access_token;
}

if (!access) {
  fail(
    "missing access token (set ANTHROPIC_ACCESS_TOKEN or authenticate in opencode/ocv)",
  );
}

const message = await fetch(MESSAGE_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "x-app": APP_ID,
    authorization: `Bearer ${access}`,
    "User-Agent": userAgent,
  },
  body: JSON.stringify({
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
    metadata: {
      user_id: JSON.stringify({
        device_id: DEVICE_ID,
        account_uuid: "",
        session_id: crypto.randomUUID(),
      }),
    },
  }),
});

if (!message.ok) {
  const body = await message.text();
  fail(`model=${model} status=${message.status} body=${body.slice(0, 300)}`);
}

console.log(refreshMode ? "smoke ok: refresh + messages" : "smoke ok: messages");
