# vt-proxy e IJ Sitesecure

Worker da Cloudflare que serve duas ferramentas do site itibere.tec.br:

- **Checagem de hash e link** (`/hash`, `/url`): proxy fino para a API v3 do VirusTotal. Guarda a chave da API fora do navegador e libera CORS para o site.
- **IJ Sitesecure** (`/sitesecure/analisar`): verificador de sites e de PIX copia e cola. Recebe um link ou um código PIX, consulta fontes públicas e devolve um laudo com nota (bom, médio ou baixo) e a lista de evidências que levou a ela.

O worker responde em `https://api.itibere.tec.br` (Custom Domain). O endereço `workers.dev` está desligado, porque firewalls corporativos classificam `*.workers.dev` como "Web Hosting" e bloqueiam.

## Sumário

1. [Objetivo e escopo](#1-objetivo-e-escopo)
2. [Arquitetura](#2-arquitetura)
3. [Instalação e deploy](#3-instalação-e-deploy)
4. [O que acontece ao colar um link](#4-o-que-acontece-ao-colar-um-link)
5. [O que acontece ao colar um PIX copia e cola](#5-o-que-acontece-ao-colar-um-pix-copia-e-cola)
6. [Como a nota é calculada](#6-como-a-nota-é-calculada)
7. [Proteção da própria ferramenta](#7-proteção-da-própria-ferramenta)
8. [Testes e validação](#8-testes-e-validação)
9. [Limitações conhecidas](#9-limitações-conhecidas)
10. [Referências](#10-referências)

---

## 1. Objetivo e escopo

Este projeto é o trabalho prático de conclusão do curso de Computação Forense e Segurança da Informação do Instituto de Pós-Graduação (IPOG). O trabalho é individual, sem orientador, e é o projeto principal do portfólio profissional entregue no mesmo curso. A ferramenta está publicada em itibere.tec.br/sitesecure.

Golpes por link falso e por PIX adulterado dependem de o usuário não ter como conferir rapidamente quem está do outro lado. O público-alvo é a pessoa que, antes de pagar ou de informar dados, quer conferir um link ou um código PIX copia e cola. O Sitesecure reúne, em uma consulta só, verificações que normalmente exigem vários sites: reputação em bases de ameaça, idade e titularidade do domínio, configuração de segurança do servidor, destino dos links e dos anúncios, existência da empresa na Receita Federal e integridade do código PIX.

O laudo é **indicativo**. Ele não certifica que um site é seguro nem prova que é fraudulento. Serve para o usuário decidir se confia, com os motivos à vista. Cada laudo traz a data e a hora da análise, as evidências que levaram à nota e as fontes que não responderam, e pode ser copiado pelo botão "Copiar laudo". Todas as fontes usadas são gratuitas ou de dados abertos.

A ferramenta aceita um campo único: se o texto começa com `000201`, é tratado como PIX; caso contrário, como link.

## 2. Arquitetura

```
Navegador (itibere.tec.br/sitesecure/)
   |  POST /sitesecure/analisar  {url | pix, turnstile}
   v
Cloudflare Worker "vt-proxy" (api.itibere.tec.br)
   |-- Turnstile ........ confere se é um navegador real
   |-- Durable Object ... limites por IP, teto diário, cache de laudos
   |-- Browser Rendering  abre a página num Chrome remoto (puppeteer)
   |-- Fontes externas .. VirusTotal, Safe Browsing, URLhaus, RDAP, DNS-over-HTTPS,
   |                      BrasilAPI, CNPJ.ws, Cloudflare Radar, Banco Central
   v
Resposta em NDJSON: um evento {etapa, status} por etapa concluída
e, no fim, {etapa:"laudo", laudo}. O front usa os eventos para animar o progresso.
```

Organização do código em `src/sitesecure/`:

| Arquivo | Responsabilidade |
|---|---|
| `analisar.js` | orquestra a análise de site e a entrada (guarda, Turnstile, cache) |
| `guard.js` | validação da URL e bloqueio de destinos internos (anti-SSRF) |
| `render.js` | coleta da página: navegador headless ou HTML estático |
| `dominio.js` | RDAP (idade, titular) e DNS (SPF, DMARC, CAA) |
| `hardening.js` | cabeçalhos de segurança HTTP e certificado TLS |
| `reputacao.js` | VirusTotal, Google Safe Browsing e URLhaus |
| `links.js`, `propagandas.js` | classificação dos destinos de links e de anúncios |
| `empresa.js`, `host.js` | CNPJ na Receita e dono da hospedagem |
| `governo.js` | domínios de governo e imitação de serviço público |
| `pagamento.js`, `pixonly.js`, `bancocentral.js` | gateway de pagamento, leitura do BR Code, ranking e participantes do Pix |
| `boaspraticas.js` | lista de boas práticas oficiais |
| `radar.js` | popularidade e categoria de conteúdo (Cloudflare Radar) |
| `nota.js` | regras de nota, todos os limites num objeto `LIMITES` |
| `guarda.js`, `turnstile.js` | proteção contra abuso |
| `data/*.json` | listas curadas e editáveis |

Listas curadas em `src/sitesecure/data/`: `dominios_confiaveis.json` (destinos de boa reputação), `redes_anuncio.json` (redes de anúncio confiáveis e arriscadas), `hosts_tier.json` (classificação de hospedagens) e `psp_bcb.json` (instituições de pagamento).

**Restrição de plataforma.** O plano gratuito de Workers permite 50 subrequests por invocação. Cada módulo pede cota a um objeto `Orcamento` antes de chamar a rede; sem cota, a etapa termina como "não concluída" e a análise segue. A análise de site usa no máximo 42 (36 quando há PIX junto); a de PIX, 20. Sobram cerca de 5 para a guarda.

## 3. Instalação e deploy

Rodar você mesmo, fora do Claude Code, porque o login é interativo.

1. Chave da API do VirusTotal: https://www.virustotal.com/gui/my-apikey (plano gratuito: 500 consultas por dia, 4 por minuto).
2. Conta gratuita na Cloudflare (Workers não pede cartão no plano gratuito).
3. Dependências e login:
   ```bash
   cd workers/vt-proxy
   npm install
   npx wrangler login
   ```
4. Segredos do worker (nunca vão para o código nem para o repositório):
   ```bash
   npx wrangler secret put VT_API_KEY --config wrangler.toml
   npx wrangler secret put GSB_API_KEY --config wrangler.toml         # Google Safe Browsing
   npx wrangler secret put URLHAUS_AUTH_KEY --config wrangler.toml    # abuse.ch
   npx wrangler secret put CF_RADAR_TOKEN --config wrangler.toml      # Radar: Account > Radar > Read
   npx wrangler secret put TURNSTILE_SECRET --config wrangler.toml
   ```
   Só a `VT_API_KEY` é obrigatória. Sem as outras, a fonte correspondente aparece como indisponível no laudo e a análise continua.
5. Deploy:
   ```bash
   npm run deploy
   ```

**Sempre use `npm run deploy` e `npm run dev`, ou passe `--config wrangler.toml`.** O wrangler procura um `wrangler.jsonc` subindo pastas antes do `wrangler.toml` local e, sem o `--config`, encontra o do espelho na raiz do site e age no worker errado.

Para a chave da API do Safe Browsing: ative a API no projeto do Google Cloud e restrinja a chave à "Safe Browsing API", não à "(Legacy)".

### Teste local

```bash
cp .dev.vars.example .dev.vars    # cole a VT_API_KEY real; o arquivo nunca é commitado
npm run dev                       # usa --remote: o Browser Rendering só roda na Cloudflare
curl -X POST http://localhost:8787/hash -H "Content-Type: application/json" \
  -d '{"hash":"44d88612fea8a8f36de82e1278abb02f"}'    # hash EICAR, deve vir "malicioso"
```

Sem Chrome (o baixado pelo wrangler pode ser barrado por antivírus), use `SEM_NAVEGADOR=1` e `DEV_ORIGIN=http://localhost:8000` no `.dev.vars`, suba `npx wrangler dev --config wrangler.toml --port 8799` e, na raiz do site, `python -m http.server 8000`. A página usa `http://127.0.0.1:8799` quando aberta em localhost. Nesse modo só o HTML estático é lido.

### Rotas

- `POST /hash` `{ hash }` devolve `{ found, status, message }`.
- `POST /url` `{ url }` devolve `{ done, status, message }` ou `{ queued: true, analysis_id }`.
- `GET /url/:analysis_id` devolve `{ done: false }` ou `{ done: true, status, message }`.
- `POST /sitesecure/analisar` `{ url?, pix?, turnstile }` devolve NDJSON com um evento por etapa e, no fim, `{etapa:"laudo", laudo}` ou `{etapa:"erro", erro}`.

---

## 4. O que acontece ao colar um link

A ordem abaixo é a do código em `analisar.js`. Cada etapa emite um evento de progresso para o front.

### 4.1 Entrada: quem pode consultar

Antes de qualquer análise, o worker decide se aceita o pedido. A ordem importa, porque cada passo protege a cota do seguinte.

1. **IP bloqueado?** Um IP que já foi recusado várias vezes recebe `429` sem custo.
2. **Turnstile.** O front envia um token do widget invisível da Cloudflare, e o worker o valida no `siteverify`. Sem token válido, a resposta é `403` com `verificacao_humana`. O modo `exigir` está ativo (variável `TURNSTILE_MODO`).
3. **Cache.** Se a mesma entrada foi analisada na última hora, devolve o laudo guardado, sem gastar cota. O laudo volta marcado com o horário original (`doCache`).
4. **Limite do IP.** Janela deslizante de 5 análises em 10 minutos e 20 por dia.
5. **Teto geral.** No máximo 150 análises por dia, somando todos os IPs.

Detalhes na seção 7.

### 4.2 Validação da URL

`guard.js` normaliza a entrada e recusa o que não é um site público da internet. Isso evita que a ferramenta seja usada para acessar a rede interna do provedor (SSRF).

- Sem esquema, assume `https://`. Só aceita `http` e `https`.
- Só as portas 80 e 443.
- Recusa URL com usuário e senha embutidos.
- Recusa endereço IP literal e nomes sem ponto.
- Recusa sufixos internos: `localhost`, `local`, `internal`, `intranet`, `lan`, `home`, `corp`, `localdomain`, `arpa`, `test`, `invalid` e `example`.
- Limite de 2048 caracteres; o fragmento (`#...`) é removido.

Depois, o nome é resolvido por DNS-over-HTTPS e a análise é recusada se qualquer endereço A cair em faixa privada ou reservada (10.0.0.0/8, 127.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15, 0.0.0.0/8 e multicast). Se o site redirecionar para um destino assim, a análise também é interrompida. O bit AD da resposta indica se o domínio tem DNSSEC validado.

### 4.3 Coleta em paralelo

Três coletas rodam ao mesmo tempo, porque a renderização da página é a parte lenta.

**Domínio** (`dominio.js`)
- RDAP do domínio raiz (registro.br para `.br`, rdap.org para os demais): data de registro, idade em dias, expiração, CNPJ do titular e se a delegação tem DNSSEC.
- DNS: registro SPF (e se termina em `-all` ou `~all`), política DMARC (`none`, `quarantine`, `reject`) e existência de registro CAA.

**Página** (`render.js`)
- Abre o site num Chrome remoto (Cloudflare Browser Rendering, via puppeteer) com janela de 1366x900, espera a rede ficar ociosa e mais 2,5 segundos, porque anúncios costumam carregar depois. Há um teto de 45 segundos para a etapa.
- Captura: URL final, status HTTP, cabeçalhos, cadeia de redirecionamentos, dados do certificado TLS (emissor, protocolo, validade), até 400 requisições de rede, até 600 links da página e 20 por iframe (marcados com a zona: cabeçalho, rodapé ou corpo, e se estão dentro de um bloco de anúncio), campo de número de cartão, texto visível (até 60 mil caracteres) e o texto do cabeçalho e do rodapé.
- **Fallback estático:** se o navegador não está disponível (a cota gratuita é de 10 minutos por dia) ou passa do tempo, a página é lida como HTML puro, até 1,5 MB. Nesse modo não há dados de TLS e anúncios injetados por JavaScript não aparecem; o laudo informa o modo usado.

**Reputação** (`reputacao.js`)
- **VirusTotal:** consulta o domínio raiz. Usa a contagem de engines que classificam como malicioso ou suspeito, o total de engines, as categorias e a data de criação. Nomes de fornecedores conhecidos (Fortinet, Sophos, Kaspersky e outros) aparecem no laudo quando têm veredito.
- **URLhaus (abuse.ch):** consulta o host e informa se está listado e quantas URLs de malware estão online.

### 4.4 Governo, redirecionamento e hardening

**Governo** (`governo.js`). Sufixos que só órgãos públicos conseguem registrar (`.gov.br`, `.jus.br`, `.leg.br`, `.mp.br`, `.mil.br`, `.def.br`) e sufixos equivalentes de governos estrangeiros recebem o selo de governo. O selo prova identidade, não limpeza: um site público invadido continua sendo detectado pelas demais etapas. Também é feita a detecção inversa: endereços que usam termos de serviço público (`gov-br`, `receita-federal`, `restituicao`, `inss`, `detran`, `bolsa-familia` e similares) sem ser domínio de governo.

**Redirecionamento.** Se a URL final tem outro domínio raiz, o redirecionamento só é considerado suspeito quando o destino não é da mesma empresa (mesmos 8 primeiros dígitos do CNPJ do titular no registro.br), não é governo, não está na lista de confiáveis e não é um domínio popular.

**Hardening** (`hardening.js`, `boaspraticas.js`, `radar.js`). Seis itens, contados de 0 a 6:

| Item | Critério |
|---|---|
| HTTPS | a URL final começa com `https://` |
| HSTS | `Strict-Transport-Security` com `max-age` de pelo menos 180 dias |
| CSP | cabeçalho `Content-Security-Policy` presente |
| Proteção contra clickjacking | `frame-ancestors` na CSP ou `X-Frame-Options` com `DENY` ou `SAMEORIGIN` |
| `nosniff` | `X-Content-Type-Options: nosniff` |
| Referrer-Policy | cabeçalho presente |

Além deles: o certificado (dias para vencer), se `http://` redireciona para `https://`, se existe `/.well-known/security.txt` com contato (RFC 9116), se o domínio está na lista de pré-carregamento HSTS, e a popularidade e a categoria de conteúdo do domínio no Cloudflare Radar.

### 4.5 Links e anúncios

`links.js` agrupa todos os links por domínio raiz de destino e classifica cada um.

- Links de clique de anúncio escondem o destino real num parâmetro (`adurl`, `url`, `dest`, `redirect` e outros); o destino real é extraído.
- Encurtadores conhecidos (bit.ly, tinyurl, t.co e outros) são seguidos por até 3 saltos para descobrir o destino final.
- Classificação por nome: governo e lista de confiáveis dão nível bom; `.bet.br` dá médio (aposta autorizada); nome com padrão de aposta fora de `.bet.br` ou de conteúdo adulto dá baixo. Desde 2025 só apostas autorizadas operam em `.bet.br` (Portaria SPA/MF 1.330/2024).
- Os que sobram passam pelo DNS filtrado da Cloudflare (`family.cloudflare-dns.com`), que responde `0.0.0.0` para malware e conteúdo adulto. Resposta bloqueada dá baixo; caso contrário, neutro (sem registro negativo). São verificados até 18 domínios, anúncios primeiro.
- Os neutros restantes vão ao Cloudflare Radar (até 8): domínio popular vira bom; categoria de apostas, adulto ou malware vira baixo.

`propagandas.js` identifica as redes de anúncio carregadas pela página (listas curadas de confiáveis e arriscadas) e os anunciantes, que são os destinos de links marcados como anúncio. Para anunciantes sem reputação conhecida, consulta a idade do domínio por RDAP (até 5).

**Google Safe Browsing.** Uma única chamada em lote (até 500 URLs) com a URL informada, a URL final, exemplos de cada destino externo e até 300 links internos do próprio site. Os tipos consultados são `MALWARE`, `SOCIAL_ENGINEERING`, `UNWANTED_SOFTWARE` e `POTENTIALLY_HARMFUL_APPLICATION`. Os resultados são separados entre os que atingem o site e os que atingem links.

### 4.6 Responsável pelo site

**Empresa** (`empresa.js`). Escolhe o CNPJ nesta ordem: rodapé, titular do domínio no registro.br, corpo da página. Valida os dígitos verificadores e consulta a situação cadastral na BrasilAPI, com o CNPJ.ws como reserva. Site de governo não passa por esta etapa. O nome da razão social é comparado com o nome do site, o título e o rodapé.

**Hospedagem** (`host.js`). Identifica o dono do IP por RDAP (a ARIN redireciona ao registro regional correto), com o ASN do Cloudflare Radar como reserva. Cabeçalhos como `x-vercel-id`, `x-shopify-stage` e `x-vtex-cache-status` revelam a plataforma mesmo atrás de CDN. O resultado é comparado com `data/hosts_tier.json`; hospedagem fora da lista fica como neutra e não afeta a nota.

### 4.7 Pagamento, PIX e Reclame Aqui

- **Pagamento** (`pagamento.js`): o site é tratado como loja se carrega requisições de um gateway conhecido (Mercado Pago, PagSeguro, Stripe, Pagar.me, Asaas, Cielo, Getnet, Adyen, PayPal e outros) ou tem campo de número de cartão. Citar "PIX" no texto, por si só, não classifica como loja.
- **PIX na página:** se a página exibe um código PIX copia e cola (até 3 são procurados), ele é lido e comparado com o CNPJ do site (regras na seção 5). O usuário também pode informar um código junto com o link.
- **Reclame Aqui** (`reclameaqui.js`): só para lojas. O site não tem API pública e bloqueia acesso automatizado; a ferramenta tenta e, se falhar, mostra o link de busca como observação, sem penalizar a nota.

### 4.8 Boas práticas oficiais

`boaspraticas.js` conta o que o site cumpre. Isso só alivia alertas leves, nunca anula um alerta grave.

| Grupo | Item | Fonte |
|---|---|---|
| Técnica | HTTPS com TLS 1.2 ou superior | NIST SP 800-52r2 |
| Técnica | HSTS ativo (mínimo 180 dias) | CISA BOD 18-01 |
| Técnica | Lista de pré-carregamento HSTS | hstspreload.org |
| Técnica | Content-Security-Policy, clickjacking, `nosniff`, Referrer-Policy, Permissions-Policy | OWASP Secure Headers |
| Técnica | `security.txt` com contato | RFC 9116 |
| Técnica | DNSSEC | NIST SP 800-177 |
| Técnica | Registro CAA | RFC 8659 |
| Técnica | DMARC `quarantine` ou `reject` | NIST SP 800-177, CISA BOD 18-01 |
| Técnica | Sem conteúdo misto (só no modo navegador) | OWASP |
| Consumidor | Política de privacidade | LGPD, art. 9º |
| Consumidor (só lojas) | Razão social e CNPJ visíveis, endereço físico, canal de contato | Decreto 7.962/2013, art. 2º |
| Consumidor (só lojas) | Política de trocas e devoluções | CDC, art. 49 |
| Consumidor (só lojas) | CNPJ do site igual ao titular do domínio | registro.br |

Itens que não puderam ser verificados (por exemplo, sem dado de DNS) ficam de fora da contagem, em vez de contarem como falha.

### 4.9 Laudo

O laudo tem a nota final, os quatro blocos com alertas, pontos positivos e observações, e a seção de detalhes com os dados brutos (domínio, popularidade, boas práticas, hardening, VirusTotal, empresa, hospedagem, pagamento, destinos e quantidade de subrequests usadas). A lista `fontesIndisponiveis` diz quais fontes não responderam nessa análise.

---

## 5. O que acontece ao colar um PIX copia e cola

O código PIX (BR Code) é um texto no formato EMV, definido no Manual de Padrões para Iniciação do Pix do Banco Central. Um código começa com `000201`. A análise (`pixonly.js` e `pagamento.js`) tem estas etapas.

### 5.1 Leitura do código (`pix-leitura`)

O texto é lido como uma sequência de campos TLV (identificador de 2 dígitos, tamanho de 2 dígitos, valor). São extraídos:

- o campo `26`, que precisa conter o arranjo `br.gov.bcb.pix`; sem ele o código é recusado;
- a **chave Pix** (subcampo `01`) e o tipo dela: CNPJ (com dígitos verificadores válidos), CPF, telefone (`+55` mais DDD), e-mail ou chave aleatória (UUID);
- o **endereço do QR dinâmico** (subcampo `25`), se existir. Um Pix dinâmico traz um endereço de instituição de pagamento em vez da chave;
- o nome do recebedor (campo `59`), a cidade (`60`) e o valor (`54`), quando informados.

Se o texto não começa com `000201` ou não tem o arranjo Pix, a análise termina com `pix_invalido`.

### 5.2 Integridade do código (CRC)

O último campo (`6304` mais 4 dígitos) é um CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF) calculado sobre todo o restante. A ferramenta recalcula e compara.

- CRC confere: pontos positivos ("código íntegro").
- CRC não confere: **nota baixa**. O código foi alterado ou está incompleto. O aplicativo do banco deve recusar um código assim; o laudo orienta a não tentar corrigir à mão.

Observe que o CRC só detecta alteração acidental ou manual. Quem gera um código falso do zero calcula um CRC válido, então CRC íntegro não prova que o destinatário é legítimo.

### 5.3 Titular da chave (`pix-titular`)

O que dá para verificar depende do tipo da chave:

| Tipo | Verificação | Resultado |
|---|---|---|
| CNPJ | consulta à Receita (BrasilAPI, com CNPJ.ws de reserva) | CNPJ inexistente ou inativo: baixo. Empresa com menos de 180 dias: médio. Nome do recebedor que não condiz com a razão social ou o nome fantasia (exceto intermediador de pagamento): baixo. Se condiz: positivo |
| CPF | não há consulta pública | médio: o dinheiro vai para pessoa física, sinal de atenção numa compra em loja. O CPF aparece mascarado no laudo |
| E-mail | idade (RDAP) do domínio do e-mail | domínio com menos de 30 dias: baixo; menos de 1 ano: médio |
| Aleatória ou QR dinâmico | o titular não é público (base DICT do Banco Central) | observação: conferir nome e documento no app do banco |
| Telefone | não há consulta pública | sem verificação; vale a orientação final de conferir o destinatário no app do banco |

### 5.4 Endereço do QR dinâmico (`pix-reputacao`)

Só para Pix dinâmico. O endereço do campo `25` pertence à instituição de pagamento e é consultado no Google Safe Browsing e no RDAP.

- Endereço marcado pelo Safe Browsing: **baixo**.
- Domínio do endereço criado há menos de 30 dias: **baixo**.

Se o endereço também não pertence a uma instituição de pagamento conhecida nem a um órgão de governo, o resultado é médio (regra aplicada na etapa seguinte).

### 5.5 Instituição de pagamento (`pix-instituicao`)

A instituição que recebe o dinheiro é identificada pelo endereço do QR dinâmico ou pelo nome do recebedor, com base em `data/psp_bcb.json`. Em seguida:

- **Lista de participantes do Pix.** O Banco Central publica um CSV diário com as instituições participantes. Se a instituição consta e está autorizada, é ponto positivo; se não consta, é **médio** (o pagamento passa por outra instituição).
- **Ranking de reclamações do Banco Central.** A posição da instituição no índice de reclamações é exibida no laudo, mas **não altera a nota**, porque instituição grande e legítima também tem índice alto.
- Se a chave é o CNPJ de uma instituição participante, ou se o recebedor é um intermediador conhecido (Mercado Pago, PagSeguro, Asaas e similares), o laudo avisa que o nome do lojista não aparece e que o valor passa pela conta da instituição.

### 5.6 Nota do PIX

Baixo se houver qualquer alerta grave (CRC inválido, CNPJ inexistente ou inativo, recebedor que não condiz, endereço marcado ou muito novo). Médio se houver só alertas médios. Bom nos demais casos. O laudo sempre termina com a orientação de conferir, no app do banco, o nome e o documento de quem vai receber.

**Chave mascarada.** CPF, e-mail e telefone aparecem parcialmente ocultos no laudo, porque são dados pessoais.

### 5.7 PIX encontrado numa página

Quando um código PIX está no texto de uma página analisada (ou é informado junto com o link), ele é comparado com o CNPJ do site (`compararPix`): mesmo CNPJ, filial da mesma empresa (mesmos 8 primeiros dígitos), CNPJ diferente (baixo), chave CPF (baixo), ou site sem CNPJ para comparar (médio). O resultado entra no bloco de reputação do domínio.

---

## 6. Como a nota é calculada

Todas as regras estão em `src/sitesecure/nota.js`; os limites numéricos ficam no objeto `LIMITES`.

| Constante | Valor | Uso |
|---|---|---|
| `dominioNovoDias` | 30 | domínio "muito novo" |
| `dominioJovemDias` | 365 | domínio com menos de 1 ano |
| `empresaNovaDias` | 180 | empresa "recente" |
| `vtMaliciososBaixo` | 2 | engines do VirusTotal para nota baixa |
| `hardeningMinimo` | 4 de 6 | hardening considerado adequado |
| `certificadoVencendoDias` | 7 | certificado prestes a vencer |
| `mediosParaNotaMedia` | 2 | blocos médios para a nota final ser média |
| `boasPraticasAlivio` | 60% | proporção que alivia alertas leves |
| `consumidorFaltandoMedio` | 2 | itens do Decreto 7.962/CDC faltando para virar médio |

A nota tem quatro blocos. Cada um vira **baixo** se tiver qualquer evidência grave, **médio** se tiver alguma evidência de nível médio, e **bom** nos demais casos. O laudo mostra os nomes abaixo; o código usa os identificadores entre parênteses.

**Reputação do domínio** (`reputacaoDominio`)

- Baixo: domínio com menos de 30 dias e hardening abaixo de 4 itens; imitação de serviço público em domínio com menos de 1 ano; categoria do Radar de malware, phishing, comando e controle ou mineração; apostas fora de `.bet.br`; 2 ou mais engines do VirusTotal marcando malicioso; Safe Browsing marcando o site; URLhaus com URLs de malware ativas; site sem HTTPS; CNPJ com situação diferente de ativa; comparação de PIX de nível baixo. Em site de governo, qualquer alerta grave vem com a mensagem de possível invasão.
- Médio: domínio com menos de 30 dias e hardening adequado; domínio entre 30 e 365 dias que não seja popular no Radar nem de governo; imitação de serviço público em domínio antigo; outra categoria ruim no Radar; 1 engine do VirusTotal com alerta; certificado vencendo em menos de 7 dias.
- Alertas leves: idade do domínio não informada, domínio desconhecido no VirusTotal (e não popular), histórico de malware já offline no URLhaus, hardening fraco, `http://` sem redirecionar para HTTPS, ausência de SPF e DMARC restritivos. Dois ou mais alertas leves viram médio, **exceto** se o site cumpre 60% ou mais das boas práticas; nesse caso viram observação.

**Destino dos links** (`confiancaLinks`)

- Baixo: link externo (que não seja anúncio) para destino de nível baixo; Safe Browsing marcando um link.
- Médio: redirecionamento suspeito para outro domínio; links por encurtador; destinos de nível médio.

**Segurança dos anúncios** (`propagandas`)

- Não avaliado (`na`): navegador indisponível e nenhuma propaganda encontrada, ou site que respondeu com uma tela de verificação anti-robô. Esse bloco é ignorado na nota final.
- Sem navegador, mas com anúncios no HTML: o nível é calculado sobre esses anúncios e o bloco recebe a observação de que os anúncios carregados por JavaScript não foram vistos.
- Baixo: rede de anúncio arriscada; anunciante de nível baixo.
- Médio: anunciante de nível médio; anunciante sem reputação conhecida **e** com domínio de menos de 1 ano. Anunciante sem reputação com 1 ano ou mais, ou sem data, vira só observação.

**Identificação do responsável** (`headerFooter`)

- Baixo: hospedagem de nível baixo; loja `.br` com pagamento e sem CNPJ; CNPJ que não existe na Receita; link de nível baixo no cabeçalho ou rodapé.
- Médio: hospedagem de nível médio; consulta à Receita que falhou; empresa aberta há menos de 180 dias; razão social que não condiz com o nome do site (em loja); CNPJ do rodapé diferente do titular do domínio; 2 ou mais itens obrigatórios de loja faltando.

**Nota final**

- Baixo se qualquer bloco for baixo.
- Médio se dois ou mais blocos forem médios.
- Bom nos demais casos. Um único bloco médio não derruba a nota final, mas continua visível no laudo.

---

## 7. Proteção da própria ferramenta

Uma ferramenta que faz o servidor acessar endereços informados por terceiros e consome cotas gratuitas precisa se proteger de abuso.

- **Anti-SSRF** (seção 4.2): só sites públicos; faixas privadas recusadas antes e depois de redirecionamentos.
- **Turnstile** (`turnstile.js`): valida o token do widget invisível da Cloudflare. Se o `siteverify` da Cloudflare estiver fora do ar, o pedido passa (a ferramenta não pode cair por falha de terceiro). No modo `observar`, só registra o resultado nos logs; no modo `exigir`, recusa.
- **Guarda por IP** (`guarda.js`, Durable Object `SitesecureDO`, SQLite): 5 análises em qualquer janela de 10 minutos, 20 por dia (dia civil de Brasília). Três recusas no dia bloqueiam o IP por 1 hora, e seis por 24 horas.
- **Teto geral:** 150 análises por dia.
- **Cache de 1 hora** por entrada. O nome do objeto é derivado do IP pelo próprio Cloudflare e o IP não é gravado. O estado de cada IP é apagado 48 horas depois do último uso.
- **Chaves de API** ficam em segredos do Worker. O front nunca as recebe.
- **Chave PIX mascarada** no laudo (CPF, e-mail e telefone).
- **Content-Security-Policy** do site restringe as conexões do front a `api.itibere.tec.br`.

---

## 8. Testes e validação

### 8.1 Testes automatizados

```bash
npm test
```

O arquivo `test/nota.test.js` usa o executor nativo do Node (`node:test`) e testa as regras de `nota.js` com dados fixos, sem rede e sem gastar cota. Cada cenário monta as evidências que o `analisar.js` coletaria para um tipo de site e confere as notas de cada bloco e a final. São 31 testes em dois arquivos: `nota.test.js` (regras de nota) e `util.test.js` (domínio raiz, plataformas de subdomínio livre e detecção de tela anti-robô). Os cenários de nota cobrem: loja grande em ordem, site de governo limpo e com sinal de ameaça, Safe Browsing e VirusTotal, domínio novo e domínio popular, ausência de HTTPS, certificado vencendo, alertas leves com e sem alívio, apostas dentro e fora de `.bet.br`, imitação de serviço público, CNPJ ausente e inexistente, hospedagem, anunciantes e redes arriscadas, encurtadores, redirecionamentos e a agregação da nota final.

Esses testes protegem as regras contra regressão quando um limite é ajustado. Eles não descobrem problemas de coleta, por isso há a validação da próxima seção.

### 8.2 Validação com sites reais

O roteiro usa 8 análises, para caber nos limites do plano gratuito (20 por dia por IP e 10 minutos de navegador por dia). Cada item tem a nota esperada, definida antes da execução, e o resultado obtido.

| # | Entrada | Esperado | Verifica | Resultado |
|---|---|---|---|---|
| 1 | `kabum.com.br` | Bom | loja grande, controle | Bom nos quatro blocos e na nota final. Navegador, popularidade no top 10.000, VirusTotal 0 de 91, CNPJ ativo, hardening 4/6, boas práticas 7 de 14 |
| 2 | `gov.br` | Bom | selo de governo, sem CNPJ de empresa | Bom nos quatro blocos e na nota final. Selo de órgão público (Poder Executivo), hardening 6/6, DNSSEC sim, boas práticas 9 de 14, CNPJ não consultado (governo) |
| 3 | `testsafebrowsing.appspot.com` | Baixo | Google Safe Browsing | Baixo, como esperado. Safe Browsing marcou 4 endereços do site (`SOCIAL_ENGINEERING`, `MALWARE`, `UNWANTED_SOFTWARE`); hardening 1/6 e `http://` sem redirecionar geraram alertas leves. A validação mostrou um defeito: o domínio raiz saiu como `appspot.com` e o site herdou popularidade, idade de 21 anos e VirusTotal limpo da plataforma. Correção em duas partes: plataformas de subdomínio livre entraram na lista de sufixos, e a data de criação (RDAP e VirusTotal) é ignorada para subdomínio de plataforma. Depois da primeira parte, o VirusTotal passou a mostrar os sinais reais do subdomínio (3 engines maliciosos, 1 suspeito) |
| 4 | `tecmundo.com.br` | Bom ou médio | peso dos anúncios | Bom nos quatro blocos e na nota final. O endereço redirecionou para `estadao.com.br/tecmundo`, e o laudo avaliou o domínio de destino (popular, empresa `S/A O ESTADO DE S.PAULO` com CNPJ ativo). A coleta caiu no HTML estático (sem dados de TLS), então o bloco de anúncios só avaliou o que estava no HTML. Passou a constar uma observação sobre isso no bloco |
| 5 | `epocacosmeticos.com.br` (escolhida como loja `.br`; na prática é uma loja grande, popular no Radar) | Médio (esperado para loja pequena) | caso de reputação limitada | Bom, mas o laudo era enganoso: o site respondeu com uma verificação anti-robô (`/az-request-verify`, widget altcha) e a coleta avaliou a tela de verificação, com 1 link e sem rodapé. A nota refletia só os sinais do domínio (popular, 26 anos, CNPJ ativo, VirusTotal 0 de 91). Correção: a tela de verificação passou a ser detectada e os blocos de links e anúncios ficam "não verificados", fora da nota final. O caso de loja pequena, que exercitaria o nível médio em site real, não foi executado |
| 6 | domínio com menos de 1 ano | Médio | regra de idade | não executado; a regra é coberta pelos testes automatizados (seção 8.1) |
| 7 | PIX copia e cola de uma compra real (QR estático, chave e-mail) | Bom | leitura, CRC, instituição | Bom. CRC confere, chave do tipo e-mail e QR estático. O laudo confirmou só a integridade do código: sem endereço de QR e sem CNPJ, a instituição e o titular não puderam ser identificados. Passou a constar essa observação no laudo. A comparação do endereço do QR com a lista de instituições passou a usar o domínio raiz, para que um subdomínio com o nome de um banco não seja aceito como o banco |
| 8 | mesmo PIX com um caractere da chave alterado | Baixo (CRC deve falhar) | integridade do código | Baixo, como esperado: "código alterado ou incompleto: o dígito de controle (CRC) não confere". A validação mostrou duas falhas de texto, corrigidas: o laudo dizia também que "confirma só que o código está íntegro", o que contradizia o alerta, e a frase da nota falava em "neste site" num laudo de PIX |

**Resumo da validação.** Foram executadas 7 das 8 entradas do roteiro, em 30/09/2026: cinco sites e dois PIX. Os resultados bateram com o esperado em todas as notas finais, mas a validação expôs defeitos e limites. Os principais foram corrigidos e, quando possível, cobertos por teste: herança de reputação por subdomínio de plataforma, avaliação da tela anti-robô como se fosse o site, anúncios sem navegador sem aviso e texto contraditório no laudo de PIX. Ficaram sem cobertura em site real o nível médio (itens 5 e 6: uma loja pequena e um domínio com menos de 1 ano). Esse nível é exercitado apenas pelos testes automatizados da seção 8.1.

---

## 9. Limitações conhecidas

- **A nota é indicativa.** Um site legítimo pode receber nota média por ter pouca reputação pública, e um site fraudulento novo e bem configurado pode não ser detectado. Não há análise do conteúdo textual da página nem aprendizado de máquina.
- **Só endereços IPv4** são verificados na resolução do nome. Registros AAAA não passam pela checagem de faixa privada.
- **Sufixos públicos.** O domínio raiz é calculado com uma lista curta de sufixos de segundo nível (`com.br`, `co.uk` e semelhantes), não com a Public Suffix List completa.
- **Reclame Aqui** bloqueia acesso automatizado e não tem API pública. A reputação nele fica como observação com link para conferir. A base do consumidor.gov.br e do Sindec aponta para um host que não resolve no DNS público e o site tem WAF que recusa acesso automatizado; por isso não foram usados.
- **Cota do navegador.** Com 10 minutos por dia, as análises seguintes usam o HTML estático, que não vê anúncios carregados por JavaScript nem dados de TLS. O laudo indica o modo usado.
- **PIX dinâmico.** O endereço do QR devolve uma assinatura (JWS) que contém a chave Pix. A validação dessa assinatura não foi implementada: o manual de segurança do Pix com as regras dos campos `jku` e `x5t` não estava disponível para consulta, e faltou um QR dinâmico real para testar.
- **Listas curadas** (`data/*.json`) são mantidas à mão e podem ficar desatualizadas.
- **Sites com proteção anti-bot** podem bloquear o navegador remoto, e a análise cai no HTML estático ou falha com `site_inacessivel`. Quando o site responde com uma tela de verificação (por exemplo, a da Azion ou da Cloudflare), a ferramenta reconhece a tela pela URL, pelo título ou por uma página quase vazia que só carrega um captcha, e marca links e anúncios como "não verificado". A nota final continua usando os sinais do domínio, que não dependem da página.
- **Anúncios**: a marcação de um link como anúncio vem de termos como `banner` e `sponsor` na classe ou no id dos elementos ao redor. Banners institucionais do próprio site podem ser marcados como anúncio. Isso só altera a nota quando o destino é um domínio novo e sem reputação.
- **Domínio raiz de `gov.br`** aparece como `www.gov.br`, porque `gov.br` está na lista de sufixos.
- **Subdomínio de plataforma** (`appspot.com`, `myshopify.com`, `github.io` e outras da lista): a data de criação e o titular do registro são ignorados, porque são da plataforma. SPF e DMARC continuam sendo lidos, mas também são da plataforma.
- **Emissor do certificado**: o navegador remoto devolve o campo vazio e o laudo mostra só protocolo e validade.
- **Instituição de pagamento do PIX**: a identificação usa uma lista de nomes e compara o domínio raiz do endereço do QR dinâmico. Um domínio de golpe que contenha o nome da instituição (por exemplo, `mercadopago-pagamentos.xyz`) ainda pode ser aceito. Resolver isso exige uma lista de domínios oficiais por instituição.
- **PIX estático com chave e-mail, telefone ou aleatória**: não há como consultar o titular. O laudo confirma a integridade do código e informa que o titular não foi identificado.
- **Cache de 1 hora** pode mostrar um laudo que já não reflete o estado atual do site.

---

## 10. Referências

- Banco Central do Brasil. *Manual de Padrões para Iniciação do Pix* (BR Code, campos EMV, CRC16).
- Banco Central do Brasil. Lista de participantes do Pix e Ranking de instituições por índice de reclamações (dados abertos).
- Brasil. Decreto nº 7.962/2013, art. 2º (informações do fornecedor no comércio eletrônico).
- Brasil. Lei nº 8.078/1990 (CDC), art. 49 (direito de arrependimento).
- Brasil. Lei nº 13.709/2018 (LGPD), art. 9º.
- Ministério da Fazenda. Portaria SPA/MF nº 1.330/2024 (apostas de quota fixa em `.bet.br`).
- NIST SP 800-52 Rev. 2 (TLS); NIST SP 800-177 Rev. 1 (e-mail e DNS); NIST SP 800-53 (SC-8, SC-23).
- CISA BOD 18-01 (HTTPS, HSTS e DMARC).
- OWASP Secure Headers Project.
- RFC 9116 (`security.txt`); RFC 8659 (registro CAA); RFC 7483 (RDAP).
- Cloudflare: Workers, Durable Objects, Browser Rendering, Turnstile, Radar e DNS-over-HTTPS (`1.1.1.3`).
- Google Safe Browsing API v4; VirusTotal API v3; URLhaus (abuse.ch).
