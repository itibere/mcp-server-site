# Colocar no ar em itibere.tec.br

Cinco passos. O único que demora é a propagação do DNS.

---

## 1. Criar o repositório no GitHub

O repositório precisa ser **público** (GitHub Pages com domínio próprio só é
gratuito em repositório público). O nome pode ser qualquer um — `itibere-tec-br`
serve bem.

Na máquina de casa, dentro da pasta do projeto:

```bash
git init
git add .
git commit -m "site: primeira versão"
git branch -M main
git remote add origin git@github.com:itibere/mcp-server-site.git
git push -u origin main
```

Se preferir HTTPS em vez de SSH, troque a URL do remote por
`https://github.com/itibere/mcp-server-site.git`.

---

## 2. Ligar o GitHub Pages

No repositório: **Settings → Pages**.

- **Source:** `Deploy from a branch`
- **Branch:** `main`, pasta `/ (root)` → **Save**

Em cerca de um minuto o site já responde em
`https://itibere.github.io/mcp-server-site/`. Confira que abriu antes de
mexer no DNS — assim, se algo falhar depois, você sabe que o problema é de
domínio e não de conteúdo.

---

## 3. Apontar o domínio no registro.br

Entre em [registro.br](https://registro.br) → seu domínio → **Editar zona DNS**.

Adicione **quatro registros A** no nome vazio (o apex, `itibere.tec.br`):

| Tipo | Nome | Valor |
|------|------|-------|
| A | (vazio) | `185.199.108.153` |
| A | (vazio) | `185.199.109.153` |
| A | (vazio) | `185.199.110.153` |
| A | (vazio) | `185.199.111.153` |

E, para quem digitar `www`, **um CNAME**:

| Tipo | Nome | Valor |
|------|------|-------|
| CNAME | `www` | `itibere.github.io.` |

O ponto final no fim do CNAME importa no painel do registro.br.

Opcionalmente, para IPv6, quatro registros AAAA no apex:
`2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`,
`2606:50c0:8003::153`.

---

## 4. Declarar o domínio no GitHub

De volta em **Settings → Pages → Custom domain**: digite `itibere.tec.br` e
salve. O arquivo `CNAME` já está no repositório com esse conteúdo, então o
GitHub deve reconhecer o domínio direto.

O GitHub vai verificar o DNS. Enquanto a propagação não terminar, ele mostra
"DNS check in progress" — isso é normal e costuma levar de minutos a algumas
horas.

Para acompanhar de fora:

```bash
dig +short itibere.tec.br
# deve devolver os quatro IPs 185.199.x.153
```

---

## 5. Forçar HTTPS

Quando o check de DNS passar, a caixa **Enforce HTTPS** fica disponível na
mesma tela. Marque. O certificado é emitido automaticamente pelo GitHub e
renovado sozinho.

A opção pode levar até 24 horas para aparecer. Se ela ainda estiver cinza,
espere — não é erro.

---

## Depois: atualizar o conteúdo

Qualquer mudança é `git push`. O Pages republica em cerca de um minuto.

Para atualizar os dados do painel:

```bash
./scripts/publicar.sh --dias 90 --uf DF     # coleta real
./scripts/publicar.sh --exemplo             # volta aos dados sintéticos
```

Para deixar a coleta agendada na máquina de casa:

```bash
# ajuste usuário e caminhos dentro do arquivo .service antes
sudo cp deploy/pncp-dashboard.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pncp-dashboard.timer
systemctl list-timers pncp-dashboard.timer
```

---

## O que editar antes de publicar

Três pontos ficaram com marcador para você trocar:

1. `index.html` — os links do rodapé (`SEU-USUARIO` no GitHub e `SEU-PERFIL`
   no LinkedIn).
2. `index.html` — a linha de certificações, hoje genérica. Vale nomear as que
   você tem, é o tipo de coisa que recrutador procura.
3. `deploy/pncp-dashboard.service` — usuário, caminho do repositório e chave SSH.

---

## Se algo der errado

**O site abre em `github.io` mas não no domínio.** DNS ainda propagando, ou os
registros A estão em um nome diferente do apex. Confira com `dig +short`.

**Erro de certificado ao abrir por HTTPS.** O certificado só é emitido depois
que o DNS resolve. Espere o check passar e marque Enforce HTTPS.

**A página do painel abre vazia.** Ela busca `dados.json` na mesma pasta; confira
que `projetos/pncp/dados.json` foi versionado e existe no repositório.

**O CSS não carrega ao abrir o arquivo com dois cliques.** Os caminhos são
relativos e funcionam tanto na raiz do domínio quanto em subpasta
(`usuario.github.io/repositorio/`), mas o painel busca `dados.json` por HTTP.
Para testar localmente rode `python3 -m http.server` na raiz do projeto e abra
`http://localhost:8000`, em vez de abrir o HTML direto do disco.
