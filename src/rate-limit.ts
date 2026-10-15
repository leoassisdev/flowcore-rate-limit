// rate-limit.ts · Criado por FlowCore Soluções LTDA · flowcoresolucoes.com.br/codigos · licença MIT
// Limite de requisições pra proteger login, API pública, envio de SMS/e-mail
// e endpoints caros: janela deslizante (sliding window counter, preciso e
// barato) e balde de fichas (token bucket, permite rajadas controladas).
// Armazém plugável (memória incluída; a interface mapeia direto pra Redis
// INCRBY/PEXPIRE, Cloudflare KV/Durable Objects ou Upstash) e headers
// RateLimit-* + Retry-After prontos.
// Roda em Node 18+, Cloudflare Workers, Deno e Bun.
// Zero dependências.
//
// Referências: IETF draft "RateLimit header fields for HTTP"
// (draft-ietf-httpapi-ratelimit-headers) e RFC 9110 §10.2.3 (Retry-After).

export const CRIADO_POR = "Criado por FlowCore Soluções LTDA";

/**
 * Contrato do armazém. Em Redis: incrementar = INCRBY + PEXPIRE (MULTI),
 * lerEstado/gravarEstado = GET/SET PX (use script Lua se precisar de atomicidade estrita).
 */
export interface ArmazemRateLimit {
  incrementar(chave: string, quantidade: number, ttlMs: number): Promise<number>;
  obterContador(chave: string): Promise<number>;
  lerEstado<T>(chave: string): Promise<T | null>;
  gravarEstado<T>(chave: string, estado: T, ttlMs: number): Promise<void>;
}

export class ArmazemRateLimitMemoria implements ArmazemRateLimit {
  private dados = new Map<string, { valor: unknown; expira: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  private ler(chave: string) {
    const item = this.dados.get(chave);
    if (item && item.expira <= this.now()) {
      this.dados.delete(chave);
      return undefined;
    }
    return item;
  }
  async incrementar(chave: string, quantidade: number, ttlMs: number) {
    const atual = this.ler(chave);
    const valor = ((atual?.valor as number) ?? 0) + quantidade;
    this.dados.set(chave, { valor, expira: atual?.expira ?? this.now() + ttlMs });
    return valor;
  }
  async obterContador(chave: string) {
    return (this.ler(chave)?.valor as number) ?? 0;
  }
  async lerEstado<T>(chave: string) {
    const item = this.ler(chave);
    return item ? (JSON.parse(JSON.stringify(item.valor)) as T) : null;
  }
  async gravarEstado<T>(chave: string, estado: T, ttlMs: number) {
    this.dados.set(chave, { valor: JSON.parse(JSON.stringify(estado)), expira: this.now() + ttlMs });
  }
  /** Remove itens expirados (chame num setInterval em processos longos). */
  limpar() {
    for (const k of [...this.dados.keys()]) this.ler(k);
  }
}

export type ResultadoLimite = {
  permitido: boolean;
  limite: number;
  restante: number;
  /** Segundos até a cota se recompor (janela atual acabar / balde encher). */
  resetEmSegundos: number;
  /** Só quando bloqueado: segundos sugeridos pra tentar de novo. */
  retryAfterSegundos?: number;
};

/** Headers padrão pra resposta HTTP (inclua em 200 e em 429). */
export function headersRateLimit(r: ResultadoLimite): Record<string, string> {
  const h: Record<string, string> = {
    "RateLimit-Limit": String(r.limite),
    "RateLimit-Remaining": String(r.restante),
    "RateLimit-Reset": String(r.resetEmSegundos),
  };
  if (!r.permitido && r.retryAfterSegundos !== undefined) h["Retry-After"] = String(r.retryAfterSegundos);
  return h;
}

function exigirPositivo(v: number, nome: string) {
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${nome} precisa ser maior que zero`);
}

/**
 * Janela deslizante aproximada (contador da janela atual + fração da anterior).
 * Ex.: 100 requisições por minuto por IP.
 */
export function criarJanelaDeslizante(opcoes: {
  limite: number;
  janelaMs: number;
  armazem?: ArmazemRateLimit;
  prefixo?: string;
  now?: () => number;
}) {
  exigirPositivo(opcoes.limite, "limite");
  exigirPositivo(opcoes.janelaMs, "janelaMs");
  const now = opcoes.now ?? Date.now;
  const armazem = opcoes.armazem ?? new ArmazemRateLimitMemoria(now);
  const { limite, janelaMs } = opcoes;
  const prefixo = opcoes.prefixo ?? "rl:sw:";

  return {
    async consumir(chave: string, custo = 1): Promise<ResultadoLimite> {
      exigirPositivo(custo, "custo");
      const t = now();
      const janela = Math.floor(t / janelaMs);
      const decorrido = t - janela * janelaMs;
      const peso = 1 - decorrido / janelaMs;
      const kAtual = `${prefixo}${chave}:${janela}`;
      const [atual, anterior] = await Promise.all([
        armazem.obterContador(kAtual),
        armazem.obterContador(`${prefixo}${chave}:${janela - 1}`),
      ]);
      const estimado = anterior * peso + atual;
      const resetEmSegundos = Math.max(1, Math.ceil((janelaMs - decorrido) / 1000));

      if (estimado + custo > limite) {
        let esperaMs = janelaMs - decorrido;
        const folga = limite - atual - custo;
        if (folga >= 0 && anterior > 0) esperaMs = Math.max(0, janelaMs * (1 - folga / anterior) - decorrido);
        return {
          permitido: false,
          limite,
          restante: 0,
          resetEmSegundos,
          retryAfterSegundos: Math.max(1, Math.ceil(esperaMs / 1000)),
        };
      }
      const novo = await armazem.incrementar(kAtual, custo, janelaMs * 2);
      return { permitido: true, limite, restante: Math.max(0, Math.floor(limite - (anterior * peso + novo))), resetEmSegundos };
    },
  };
}

type EstadoBalde = { fichas: number; atualizadoEm: number };

/**
 * Balde de fichas: começa cheio (capacidade), recarrega `recargaPorSegundo`.
 * Ex.: capacidade 10 e 1/s = rajada de 10 e depois 1 por segundo.
 */
export function criarBaldeDeFichas(opcoes: {
  capacidade: number;
  recargaPorSegundo: number;
  armazem?: ArmazemRateLimit;
  prefixo?: string;
  now?: () => number;
}) {
  exigirPositivo(opcoes.capacidade, "capacidade");
  exigirPositivo(opcoes.recargaPorSegundo, "recargaPorSegundo");
  const now = opcoes.now ?? Date.now;
  const armazem = opcoes.armazem ?? new ArmazemRateLimitMemoria(now);
  const { capacidade, recargaPorSegundo } = opcoes;
  const prefixo = opcoes.prefixo ?? "rl:tb:";
  const ttlMs = Math.ceil((capacidade / recargaPorSegundo) * 1000) + 1000;

  return {
    async consumir(chave: string, custo = 1): Promise<ResultadoLimite> {
      exigirPositivo(custo, "custo");
      if (custo > capacidade) throw new Error("Custo maior que a capacidade do balde nunca será atendido");
      const t = now();
      const k = prefixo + chave;
      const estado = (await armazem.lerEstado<EstadoBalde>(k)) ?? { fichas: capacidade, atualizadoEm: t };
      const recarga = (Math.max(0, t - estado.atualizadoEm) / 1000) * recargaPorSegundo;
      let fichas = Math.min(capacidade, estado.fichas + recarga);
      const permitido = fichas >= custo;
      if (permitido) fichas -= custo;
      await armazem.gravarEstado<EstadoBalde>(k, { fichas, atualizadoEm: t }, ttlMs);
      const resetEmSegundos = Math.ceil((capacidade - fichas) / recargaPorSegundo);
      return {
        permitido,
        limite: capacidade,
        restante: Math.floor(fichas),
        resetEmSegundos,
        ...(permitido ? {} : { retryAfterSegundos: Math.max(1, Math.ceil((custo - fichas) / recargaPorSegundo)) }),
      };
    },
  };
}
