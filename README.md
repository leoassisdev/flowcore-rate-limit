# Rate Limit

> Limita requisições por IP, usuário ou chave com janela deslizante ou balde de fichas, armazém plugável (memória, Redis, KV) e headers RateLimit-*. Login e API protegidos contra abuso e robô.

**Ver ao vivo, com preview e manual:** https://flowcoresolucoes.com.br/codigos/rate-limit

Criado por **FlowCore Soluções LTDA**.

## Arquivos

- [`src/rate-limit.ts`](src/rate-limit.ts)
- [`src/rate-limit.test.ts`](src/rate-limit.test.ts)

## Como instalar

1. **Funciona onde você já roda** Node 18+, Cloudflare Workers, Deno, Bun, Vercel e Netlify Functions. Zero dependência: só fetch e Web Crypto, que já vêm no runtime.
2. **Crie src/lib/rate-limit.ts** Copie o conteúdo de `src/rate-limit.ts` e `src/rate-limit.test.ts` deste repositório.
3. **Use**

   ```bash
   const limite = criarJanelaDeslizante({ limite: 5, janelaMs: 60_000 });
   const r = await limite.consumir(`login:${ip}`);
   if (!r.permitido) {
     return new Response("Muitas tentativas", { status: 429, headers: headersRateLimit(r) });
   }
   ```

4. **Rode o teste junto** O arquivo de teste (`src/rate-limit.test.ts`) cobre 8 cenários. Copie para src/lib/ ao lado e rode:

   ```bash
   npm install -D vitest
   npx vitest run src/lib
   ```


## Testes

`src/rate-limit.test.ts` cobre 8 cenários.

```bash
npm install
npm test
```

## Licença

MIT. Pode usar em projeto pessoal ou comercial, de graça. A única condição é manter a linha **“Criado por FlowCore Soluções LTDA”** (ou o crédito de adaptação) onde ela está.

---

Precisa disso integrado no seu sistema? A [FlowCore](https://flowcoresolucoes.com.br) desenvolve sob medida.
