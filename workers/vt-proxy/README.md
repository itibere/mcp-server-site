# vt-proxy — Cloudflare Worker

Proxy fino pra API oficial do VirusTotal v3. Esconde a chave da API (nunca fica no
navegador nem no repo) e resolve CORS pra `itibere.tec.br` conseguir chamar a VT.

## Passos (rodar você mesmo, fora do Claude — exige login OAuth interativo)

1. Conta grátis no VirusTotal (se ainda não tiver): https://www.virustotal.com — depois
   pegue sua API key em https://www.virustotal.com/gui/my-apikey (free tier: 500
   consultas/dia, 4/min).

2. Conta grátis na Cloudflare (se ainda não tiver): https://dash.cloudflare.com/sign-up
   — não pede cartão pro tier gratuito de Workers.

3. Instalar dependências:
   ```bash
   cd workers/vt-proxy
   npm install
   ```

4. Login na Cloudflare via CLI:
   ```bash
   npx wrangler login
   ```
   Abre o navegador pra autorizar.

5. Guardar a chave da VT como segredo do Worker (nunca vai pro código/repo):
   ```bash
   npx wrangler secret put VT_API_KEY
   ```
   Cola a chave do passo 1 quando pedir.

6. Deploy:
   ```bash
   npx wrangler deploy
   ```
   Anota a URL que aparece no final, algo como
   `https://vt-proxy.<seu-subdominio>.workers.dev` — essa URL precisa entrar como
   `API_BASE` no arquivo `seguranca/checagem-hash-link/index.html`.

## Testar localmente antes do deploy

```bash
cp .dev.vars.example .dev.vars   # cole sua VT_API_KEY real no .dev.vars (nunca commitado)
npm run dev
```

Depois, em outro terminal:
```bash
curl -X POST http://localhost:8787/hash -H "Content-Type: application/json" \
  -d '{"hash":"44d88612fea8a8f36de82e1278abb02f"}'   # hash EICAR (teste), deve vir "malicioso"
```

## Rotas

- `POST /hash` `{ hash }` → `{ found, status, message }`
- `POST /url` `{ url }` → `{ done, status, message }` ou `{ queued: true, analysis_id }`
- `GET /url/:analysis_id` → `{ done: false }` ou `{ done: true, status, message }`
