// Anthropic rejects newer models from older client versions; override without a rebuild via the env var.
export const CLAUDE_CODE_VERSION = process.env.CLAUDE_CODE_VERSION?.trim() || "2.1.294";
export const REQUEST_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
