# Changelog

## 0.0.4

- Added localhost OAuth callback flow (`method: "auto"`) with fallback to manual code entry
- Kept token exchange compatible with callback URL, code/state, and PKCE validation

## 0.0.3

- Made `npm run smoke` non-destructive by default
- Added explicit `smoke:refresh` mode for refresh-token validation
- Switched smoke default model to `claude-3-haiku-20240307`
- Added npm metadata links

## 0.0.2

- Switched OAuth token endpoints to `platform.claude.com`
- Set token exchange/refresh User-Agent to `axios/1.13.6`
- Set Anthropic API User-Agent to `claude-code/2.1.80`

## 0.0.1

- Initial release of Anthropic OAuth plugin for OpenCode-compatible clients
