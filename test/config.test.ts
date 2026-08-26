/**
 * Configuration, and the one distinction that decides whether a bot is
 * dispatched into a real meeting half-configured.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/** The gate `createServer` uses to decide whether Recall is offered at all. */
function recallReady(config: ReturnType<typeof loadConfig>): boolean {
  return (
    config.recall.apiKey !== undefined &&
    config.recall.webhookBaseUrl !== undefined &&
    config.recall.webhookSecret !== undefined
  );
}

const env = (extra: Record<string, string>): NodeJS.ProcessEnv =>
  ({ ...extra }) as NodeJS.ProcessEnv;

describe("recall configuration", () => {
  it("treats a blank setting as unset, not as a value", () => {
    // A scaffolded .env has blank placeholders, which parse as "" rather than
    // undefined. Before this, `AMP_RECALL_WEBHOOK_BASE_URL=` satisfied the
    // readiness gate, the provider was offered, and dispatching a bot threw
    // `Invalid URL` — at the point a real meeting was waiting for it.
    const config = loadConfig(
      env({
        AMP_RECALL_API_KEY: "key",
        AMP_RECALL_WEBHOOK_BASE_URL: "",
        AMP_RECALL_WEBHOOK_SECRET: "secret",
      }),
    );
    expect(config.recall.webhookBaseUrl).toBeUndefined();
    expect(recallReady(config)).toBe(false);
  });

  it("treats whitespace as blank", () => {
    const config = loadConfig(
      env({
        AMP_RECALL_API_KEY: "  ",
        AMP_RECALL_WEBHOOK_BASE_URL: "https://tunnel.test",
        AMP_RECALL_WEBHOOK_SECRET: "secret",
      }),
    );
    expect(config.recall.apiKey).toBeUndefined();
    expect(recallReady(config)).toBe(false);
  });

  it("is ready only when all three are really set", () => {
    const config = loadConfig(
      env({
        AMP_RECALL_API_KEY: "key",
        AMP_RECALL_WEBHOOK_BASE_URL: "https://tunnel.test",
        AMP_RECALL_WEBHOOK_SECRET: "secret",
      }),
    );
    expect(recallReady(config)).toBe(true);
  });

  it("trims a setting rather than carrying a stray newline into a URL", () => {
    // Copy-paste out of a dashboard brings whitespace with it, and a trailing
    // space in a base URL or an API key fails somewhere far from here.
    const config = loadConfig(
      env({
        AMP_RECALL_API_KEY: " key \n",
        AMP_RECALL_WEBHOOK_BASE_URL: " https://tunnel.test ",
        AMP_RECALL_WEBHOOK_SECRET: "secret",
        AMP_RECALL_SPEAKER_URL: " https://tunnel.test/speaker.html ",
      }),
    );
    expect(config.recall.apiKey).toBe("key");
    expect(config.recall.webhookBaseUrl).toBe("https://tunnel.test");
    expect(config.recall.speakerUrl).toBe("https://tunnel.test/speaker.html");
  });

  it("leaves the simulator working when nothing is configured", () => {
    const config = loadConfig(env({}));
    expect(recallReady(config)).toBe(false);
    expect(config.recall.region).toBe("us-west-2");
    expect(config.recall.botName).toBe("AMP cofounder");
  });
});
