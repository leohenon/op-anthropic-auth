# OpenCode Anthropic Oauth

[![npm](https://img.shields.io/npm/v/op-anthropic-auth?style=flat-square&logo=npm&logoColor=white&label=npm&color=teal)](https://www.npmjs.com/package/op-anthropic-auth) [![node](https://img.shields.io/badge/node-%3E%3D18-teal?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

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

## Verify

```bash
npm run smoke
```

## License

MIT
