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
   npx wrangler secret put VT_API_KEY --config wrangler.toml
   ```
   Cola a chave do passo 1 quando pedir.

6. Deploy:
   ```bash
   npm run deploy
   ```
   Anota a URL que aparece no final, algo como
   `https://vt-proxy.<seu-subdominio>.workers.dev` e o domínio próprio `https://api.itibere.tec.br`
   (Custom Domain em `wrangler.toml`). O front (`assets/checagem-hash-link.js` e `assets/sitesecure.js`)
   usa o domínio próprio como `API_BASE`: firewalls corporativos (FortiGuard, categoria "Web Hosting")
   bloqueiam `*.workers.dev`. O `workers.dev` segue ligado (`workers_dev = true`) só por compatibilidade.

## Testar localmente antes do deploy

```bash
cp .dev.vars.example .dev.vars   # cole sua VT_API_KEY real no .dev.vars (nunca commitado)
npm run dev    # usa --remote: o Browser Rendering so roda na Cloudflare
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

- `POST /sitesecure/analisar` `{ url, pix? }` → NDJSON em stream: `{etapa, status}` por etapa e, no fim, `{etapa:"laudo", laudo}` (ou `{etapa:"erro", erro}`). Limite próprio: 5 análises / 10 min por IP.

## Sitesecure (itibere.tec.br/sitesecure/)

Verificador de sites. Código em `src/sitesecure/`; listas curadas e editáveis em `src/sitesecure/data/`
(`dominios_confiaveis.json`, `redes_anuncio.json`, `hosts_tier.json`). Regras de nota em `src/sitesecure/nota.js`; governo/imitação em `governo.js`;
boas práticas oficiais (Decreto 7.962, CDC, LGPD, NIST, CISA, OWASP, RFC 9116/8659) em `boaspraticas.js`;
popularidade e categoria de conteúdo em `radar.js`.

**Sempre** `npm run deploy` / `npm run dev` (ou `--config wrangler.toml`): o wrangler procura `wrangler.jsonc`
subindo pastas antes do `wrangler.toml` local e, sem o `--config`, pega o do espelho na raiz do site.

Segredos opcionais (sem eles, a fonte aparece como indisponível no laudo):
```bash
npx wrangler secret put GSB_API_KEY --config wrangler.toml       # Google Safe Browsing (console.cloud.google.com, API "Safe Browsing")
npx wrangler secret put URLHAUS_AUTH_KEY --config wrangler.toml  # abuse.ch (auth.abuse.ch)
npx wrangler secret put CF_RADAR_TOKEN --config wrangler.toml    # Cloudflare Radar: Custom Token, Account > Radar > Read
```

Fontes gratuitas usadas: VirusTotal (a mesma `VT_API_KEY`, 1 consulta por análise), RDAP (registro.br / rdap.org /
ARIN), DNS-over-HTTPS da Cloudflare (inclusive `family.cloudflare-dns.com` como filtro de malware/adulto),
BrasilAPI e CNPJ.ws (reserva), Reclame Aqui best-effort. Browser Rendering no plano free: 10 min de navegador por dia;
sem cota, a análise lê só o HTML estático.

Teste local sem Chrome (o Chrome baixado pelo wrangler pode ser barrado pelo antivírus): `SEM_NAVEGADOR=1` e
`DEV_ORIGIN=http://localhost:8000` no `.dev.vars`, `npx wrangler dev --config wrangler.toml --port 8799` e
`python -m http.server 8000` na raiz do site; a página usa `http://127.0.0.1:8799` quando aberta em localhost.