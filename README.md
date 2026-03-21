# op-anthropic-auth

Anthropic OAuth plugin for OpenCode-compatible clients.

Current npm version: `0.0.2`

Tested with `opencode@1.2.27` and `ocv@1.2.27-vim.2.4`.

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
