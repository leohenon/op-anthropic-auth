# op-anthropic-auth

[![npm](https://img.shields.io/npm/v/op-anthropic-auth?style=flat-square&logo=npm&logoColor=white&label=npm&color=teal)](https://www.npmjs.com/package/op-anthropic-auth) [![node](https://img.shields.io/badge/node-%3E%3D18-teal?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)

OpenCode plugin for Anthropic Oauth, no extra usage required.

Use Claude Pro/Max with browser OAuth, create an Anthropic API key through OAuth, or enter an API key manually.

## Features

- Claude Pro/Max login from `/connect`
- Automatic token refresh
- Claude-compatible request shaping for OpenCode
- Extra model registration through config

> [!WARNING]
> Use at your own risk. This may go against Anthropic TOS.

> [!NOTE]
> Anthropic auth changes are closely monitored for quick compatibility updates.

## Quick start

Add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["op-anthropic-auth@latest"]
}
```

Restart OpenCode, run `/connect`, then choose one of:

- `Claude Pro/Max`
- `Create an API Key`
- `Manually enter API Key`

## Manual install

If your client does not auto-install npm plugins from config:

```bash
npm i -g op-anthropic-auth@latest
```

Then use the same config:

```json
{
  "plugin": ["op-anthropic-auth"]
}
```

## Extra models

```json
{
  "plugin": [
    [
      "op-anthropic-auth",
      {
        "extraModels": {
          "claude-new-model": {
            "name": "Claude New Model"
          }
        }
      }
    ]
  ]
}
```

`claude-opus-4.7` is included by default.

## Verify

```bash
npm run smoke
```

## How it works

The plugin:

- runs a PKCE OAuth flow against Claude or Anthropic
- stores refreshable auth in the OpenCode auth store
- refreshes tokens when needed
- adds the required Anthropic beta headers
- rewrites system and tool metadata for Claude-compatible requests

## Troubleshooting

- Re-run `/connect` if auth looks stale
- Clear the cached package if a new version is not loading:

```bash
rm -rf ~/.cache/opencode/packages/op-anthropic-auth@latest/
```

If something breaks, please open an issue with your OpenCode version, plugin version, and error output

## License

MIT
