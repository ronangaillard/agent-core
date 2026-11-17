import assert from "node:assert/strict";
import { test } from "node:test";
import { httpTools } from "../src/http.ts";

const context = (owner: boolean) => ({ scope: { owner, requester: "paul", private: false }, threadKey: "x", lotIds: [], connector: "slack", address: { connector: "slack", conversation: "c", thread: "main" } });

test("http: only the listed APIs, the token added by the code, never a host from the model; sending is an effect", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"board":"..."}', { status: 200 });
  }) as unknown as typeof fetch;
  const [get, send] = httpTools(
    { pals: { url: "https://pals.example.com", description: "the office", headers: { Authorization: "Bearer ${PAL}" } }, admin: { url: "https://admin.example.com/v1", rules: ["owner"] } },
    { env: { PAL: "pal_x" }, fetch: fakeFetch },
  );
  assert.deepEqual([get!.name, get!.effect, send!.name, send!.effect], ["http_get", undefined, "http_send", true]);
  assert.match(get!.description, /pals: https:\/\/pals\.example\.com, the office/);
  assert.equal(get!.description.includes("pal_x"), false);

  assert.equal(await get!.run({ api: "pals", path: "/api/scrabble?me=1" }, context(false)), 'HTTP 200\n{"board":"..."}');
  assert.equal(calls[0]!.url, "https://pals.example.com/api/scrabble?me=1");
  assert.deepEqual(calls[0]!.init.headers, { Authorization: "Bearer pal_x" });

  await send!.run({ api: "pals", path: "api/scrabble", method: "POST", body: { action: "play", word: "LOGE" } }, context(false));
  assert.equal(calls[1]!.init.method, "POST");
  assert.equal(calls[1]!.init.body, '{"action":"play","word":"LOGE"}');
  assert.equal((calls[1]!.init.headers as Record<string, string>)["Content-Type"], "application/json");

  assert.match(String(await get!.run({ api: "pals", path: "https://evil.com/x" }, context(false))), /outside/);
  assert.match(String(await get!.run({ api: "admin", path: "/../x" }, context(true))), /outside/);
  assert.match(String(await get!.run({ api: "admin", path: "/users" }, context(false))), /not allowed here/);
  assert.equal(calls.length, 2);
  await get!.run({ api: "admin", path: "/users" }, context(true));
  assert.equal(calls[2]!.url, "https://admin.example.com/v1/users");
});

test("http: no API, no tool; a token missing from the environment stops the start", () => {
  assert.deepEqual(httpTools({}), []);
  assert.throws(() => httpTools({ pals: { url: "https://p", headers: { Authorization: "Bearer ${NOPE}" } } }, { env: {} }), /NOPE is not set/);
});
