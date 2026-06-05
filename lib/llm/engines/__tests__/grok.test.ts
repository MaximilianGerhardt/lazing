/**
 * lib/llm/engines/__tests__/grok.test.ts — Grok (xAI) engine adapter.
 *
 * Pure unit test: global.fetch is mocked, so no network / no key required.
 * Verifies detect() gating on the API key + reachability, and chat() request
 * shape (Bearer auth, OpenAI-compatible body) + response mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { grok } from "@/lib/llm/engines/grok";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.XAI_API_KEY = "xai-test-key";
  delete process.env.LAZYOS_GROK_API_KEY;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

describe("grok engine", () => {
  it("has the right id and is a cloud HTTP adapter", () => {
    expect(grok.id).toBe("grok");
  });

  it("detect: no key → unavailable", async () => {
    delete process.env.XAI_API_KEY;
    const r = await grok.detect();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/no API key/i);
  });

  it("detect: key + 200 on /models → available", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await grok.detect();
    expect(r.available).toBe(true);
  });

  it("detect: key rejected (401) → unavailable", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const r = await grok.detect();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/rejected|401/i);
  });

  it("chat: sends Bearer auth + OpenAI-shaped body, maps the response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "hello from grok" } }],
          usage: { prompt_tokens: 11, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await grok.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(res.engine).toBe("grok");
    expect(res.text).toBe("hello from grok");
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 5 });
    expect(captured!.url).toMatch(/\/chat\/completions$/);
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer xai-test-key");
    const body = JSON.parse(captured!.init.body as string) as {
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
    };
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(body.stream).toBe(false);
  });

  it("chat: no key → throws", async () => {
    delete process.env.XAI_API_KEY;
    await expect(grok.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /no API key/i,
    );
  });
});
