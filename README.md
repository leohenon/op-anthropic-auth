# OpenCode Anthropic Oauth

[![npm](https://img.shields.io/npm/v/op-anthropic-auth?style=flat-square&logo=npm&logoColor=white&label=npm&color=teal)](https://www.npmjs.com/package/op-anthropic-auth) [![downloads](https://img.shields.io/npm/dm/op-anthropic-auth?style=flat-square&logo=npm&logoColor=white&label=downloads&color=teal)](https://www.npmjs.com/package/op-anthropic-auth) [![node](https://img.shields.io/badge/node-%3E%3D18-teal?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

Anthropic OAuth plugin for OpenCode-compatible clients.

> [!WARNING]
> Use this at your own risk. This may go against Anthropic TOS.

## Install

```bash
npm i -g op-anthropic-auth@latest
```

## Configure

`~/.config/opencode/opencode.json`

```json
{
  "plugin": ["op-anthropic-auth"]
}
```

Restart your client, run `/connect`, then choose `Anthropic API Key` -> `Claude Pro/Max`.

## Request headers

OAuth requests now send the Claude Code-style headers required by the current API:

- `anthropic-version: 2023-06-01`
- `x-app: cli`
- `anthropic-beta: oauth-2025-04-20,interleaved-thinking-2025-05-14`
- `user-agent: claude-code/<version>`

You can override the resolved version or full `User-Agent` with:

- `OP_ANTHROPIC_AUTH_CLAUDE_CODE_CHANNEL`
- `OP_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION`
- `OP_ANTHROPIC_AUTH_USER_AGENT`

## Verify

```bash
npm run smoke
```

## License

MIT
