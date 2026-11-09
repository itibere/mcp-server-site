import { test } from "node:test";
import assert from "node:assert/strict";
import { conferirTurnstile } from "../src/sitesecure/turnstile.js";
import { simularRede } from "./apoio/ambiente.js";

const ENV = { TURNSTILE_SECRET: "s" };
const rede = (t, corpo) => simularRede(t, () => Response.json(corpo));

test("hostname: so as origens do projeto; ausente, localhost e example.com recusados fora do dev", async (t) => {
  for (const [hostname, ok] of [["itibere.tec.br", true], ["itibere.github.io", true], ["outro.com", false], ["localhost", false], ["127.0.0.1", false], ["example.com", false], [undefined, false]]) {
    rede(t, { success: true, hostname, action: "analisar" });
    const r = await conferirTurnstile({ ...ENV, TURNSTILE_MODO: "exigir" }, "tk", "1.2.3.4");
    assert.equal(r.ok, ok, String(hostname));
  }
});

test("hostname de desenvolvimento so com DEV_ORIGIN, que tambem dispensa a conferencia da action", async (t) => {
  for (const hostname of ["localhost", "127.0.0.1", "example.com"]) {
    rede(t, { success: true, hostname });
    assert.equal((await conferirTurnstile({ ...ENV, DEV_ORIGIN: "http://localhost:8000", TURNSTILE_MODO: "exigir" }, "tk", "")).ok, true, hostname);
  }
});

test("action: analisar para o Site Secure e vt para o verificador de hash e link", async (t) => {
  const env = { ...ENV, TURNSTILE_MODO: "exigir" };
  rede(t, { success: true, hostname: "itibere.tec.br", action: "vt" });
  assert.equal((await conferirTurnstile(env, "tk", "")).ok, false, "token do widget vt no Site Secure");
  assert.equal((await conferirTurnstile(env, "tk", "", "exigir", "vt")).ok, true);
  rede(t, { success: true, hostname: "itibere.tec.br" });
  assert.equal((await conferirTurnstile(env, "tk", "", "exigir", "vt")).ok, false, "sem action");
});

test("conta como recusa so o invalid-input-response", async (t) => {
  const env = { ...ENV, TURNSTILE_MODO: "exigir" };
  rede(t, { success: false, "error-codes": ["invalid-input-response"] });
  assert.equal((await conferirTurnstile(env, "tk", "")).conta, true);
  rede(t, { success: false, "error-codes": ["timeout-or-duplicate"] });
  assert.equal((await conferirTurnstile(env, "tk", "")).conta, false);
  assert.equal((await conferirTurnstile(env, "", "")).conta, false, "sem token");
  assert.equal((await conferirTurnstile({ TURNSTILE_MODO: "exigir" }, "tk", "")).conta, false, "sem segredo");
});
