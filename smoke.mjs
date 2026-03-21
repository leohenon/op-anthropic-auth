const token_url = "https://platform.claude.com/v1/oauth/token";
const msg_url = "https://api.anthropic.com/v1/messages?beta=true";

const fail = (msg) => {
  console.error(`smoke failed: ${msg}`);
  process.exit(1);
};

const refresh = process.env.ANTHROPIC_REFRESH_TOKEN;
if (!refresh) {
  fail("missing ANTHROPIC_REFRESH_TOKEN");
}

const model = process.env.ANTHROPIC_SMOKE_MODEL || "claude-sonnet-4-5";

const token = await fetch(token_url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "axios/1.13.6",
  },
  body: JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  }),
});

if (!token.ok) {
  const body = await token.text();
  fail(`token refresh ${token.status}: ${body.slice(0, 500)}`);
}

const json = await token.json();
if (!json.access_token) {
  fail("token refresh returned no access_token");
}

const msg = await fetch(msg_url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
    authorization: `Bearer ${json.access_token}`,
    "User-Agent": "claude-code/2.1.80",
  },
  body: JSON.stringify({
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  }),
});

if (!msg.ok) {
  const body = await msg.text();
  fail(`messages request ${msg.status}: ${body.slice(0, 500)}`);
}

console.log("smoke ok: refresh + messages");
