import { expect, test } from "bun:test";
import {
  CLAUDE_CODE_VERSION,
  REQUEST_USER_AGENT,
} from "./src/client-metadata";

const MINIMUM_MODEL_VERSION = "2.1.280";

test("meets the minimum Claude Code version required by current models", () => {
  const versionOrder = new Intl.Collator("en", { numeric: true }).compare(
    CLAUDE_CODE_VERSION,
    MINIMUM_MODEL_VERSION,
  );

  expect(versionOrder).toBeGreaterThanOrEqual(0);
});

test("builds the request User-Agent from the shared version", () => {
  const expectedUserAgent = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;

  expect(REQUEST_USER_AGENT).toBe(expectedUserAgent);
});
