// rate-limit.test.ts · Criado por FlowCore Soluções LTDA · flowcoresolucoes.com.br/codigos · licença MIT
import { describe, expect, it } from "vitest";
import { ArmazemRateLimitMemoria, criarBaldeDeFichas, criarJanelaDeslizante, headersRateLimit } from "./rate-limit";

describe("rate-limit", () => {
  it("janela deslizante: libera até o limite e bloqueia o excedente", async () => {
    const t = 0;
    const rl = criarJanelaDeslizante({ limite: 10, janelaMs: 60_000, now: () => t });
    const restantes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await rl.consumir("ip:1");
      expect(r.permitido).toBe(true);
      restantes.push(r.restante);
    }
    expect(restantes).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    expect(await rl.consumir("ip:1")).toEqual({ permitido: false, limite: 10, restante: 0, resetEmSegundos: 60, retryAfterSegundos: 60 });
  });

  it("janela deslizante: a janela anterior pesa proporcionalmente", async () => {
    let t = 0;
    const rl = criarJanelaDeslizante({ limite: 10, janelaMs: 60_000, now: () => t });
    for (let i = 0; i < 10; i++) await rl.consumir("k");
    t = 60_000; // início da próxima janela: anterior ainda pesa 100%
    const bloqueado = await rl.consumir("k");
    expect(bloqueado).toMatchObject({ permitido: false, retryAfterSegundos: 6 });
    t = 66_000; // anterior pesa 90% => 9 estimadas
    expect(await rl.consumir("k")).toMatchObject({ permitido: true, restante: 0 });
    expect((await rl.consumir("k")).permitido).toBe(false);
    t = 180_001; // janela anterior vazia: cota cheia de novo
    expect((await rl.consumir("k")).restante).toBe(9);
  });

  it("chaves diferentes não interferem e custo maior que 1 conta", async () => {
    const t = 0;
    const rl = criarJanelaDeslizante({ limite: 5, janelaMs: 1000, now: () => t });
    expect((await rl.consumir("a", 5)).permitido).toBe(true);
    expect((await rl.consumir("a")).permitido).toBe(false);
    expect((await rl.consumir("b", 3)).restante).toBe(2);
  });

  it("balde de fichas: rajada até a capacidade e recarga contínua", async () => {
    let t = 0;
    const tb = criarBaldeDeFichas({ capacidade: 5, recargaPorSegundo: 1, now: () => t });
    for (let i = 0; i < 5; i++) expect((await tb.consumir("u")).permitido).toBe(true);
    expect(await tb.consumir("u")).toEqual({ permitido: false, limite: 5, restante: 0, resetEmSegundos: 5, retryAfterSegundos: 1 });
    t = 1000;
    expect(await tb.consumir("u")).toEqual({ permitido: true, limite: 5, restante: 0, resetEmSegundos: 5 });
    t = 60_000;
    expect((await tb.consumir("u")).restante).toBe(4);
  });

  it("balde de fichas: recarga fracionada e custo inválido", async () => {
    let t = 0;
    const tb = criarBaldeDeFichas({ capacidade: 2, recargaPorSegundo: 0.5, now: () => t });
    await tb.consumir("x", 2);
    t = 1000; // +0,5 ficha
    expect(await tb.consumir("x")).toMatchObject({ permitido: false, retryAfterSegundos: 1 });
    t = 2000; // total 1 ficha
    expect((await tb.consumir("x")).permitido).toBe(true);
    await expect(tb.consumir("x", 3)).rejects.toThrow("capacidade");
  });

  it("gera headers RateLimit-* e Retry-After só quando bloqueado", () => {
    expect(headersRateLimit({ permitido: true, limite: 10, restante: 3, resetEmSegundos: 20 })).toEqual({
      "RateLimit-Limit": "10",
      "RateLimit-Remaining": "3",
      "RateLimit-Reset": "20",
    });
    expect(headersRateLimit({ permitido: false, limite: 10, restante: 0, resetEmSegundos: 20, retryAfterSegundos: 7 })["Retry-After"]).toBe("7");
  });

  it("armazém em memória expira contadores pelo TTL", async () => {
    let t = 0;
    const a = new ArmazemRateLimitMemoria(() => t);
    expect(await a.incrementar("c", 2, 100)).toBe(2);
    expect(await a.incrementar("c", 1, 100)).toBe(3);
    t = 101;
    expect(await a.obterContador("c")).toBe(0);
    await a.gravarEstado("e", { x: 1 }, 50);
    expect(await a.lerEstado("e")).toEqual({ x: 1 });
    t = 200;
    a.limpar();
    expect(await a.lerEstado("e")).toBeNull();
  });

  it("valida configuração", () => {
    expect(() => criarJanelaDeslizante({ limite: 0, janelaMs: 1000 })).toThrow("limite");
    expect(() => criarBaldeDeFichas({ capacidade: 1, recargaPorSegundo: -1 })).toThrow("recargaPorSegundo");
  });
});
