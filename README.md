# itibere.tec.br

Site pessoal e vitrine de projetos. Estático, sem dependências externas,
publicado no GitHub Pages sob domínio próprio registrado no registro.br.

## Estrutura

```
index.html                  home — hub que separa os trabalhos
assets/style.css            tokens e componentes compartilhados
assets/dashboard.css        componentes do painel
assets/dashboard.js         gráficos em SVG puro, sem bibliotecas
projetos/pncp/index.html    monitor de contratações de TIC
projetos/pncp/dados.json    dados que o painel lê (gerado, versionado)
scripts/montar.py           contrato de dados do painel
scripts/coletar_pncp.py     coletor da API pública do PNCP
scripts/gerar_exemplo.py    dados sintéticos para o site nascer completo
scripts/publicar.sh         coleta + commit + push
deploy/                     unidades systemd para a coleta agendada
CNAME                       domínio do GitHub Pages
```

## Como o painel se atualiza

O site não roda nada em servidor. Uma máquina doméstica executa o coletor,
que consulta a API pública do PNCP e escreve `projetos/pncp/dados.json`;
o `git push` desse arquivo é o deploy. A página lê o JSON no navegador e
calcula os agregados ali mesmo, para que os filtros e os gráficos nunca
discordem entre si.

```
máquina de casa  →  dados.json  →  git push  →  GitHub Pages  →  itibere.tec.br
```

Consequência prática: nenhuma porta aberta, nenhum serviço exposto, nenhum
token em produção. Se a máquina de casa estiver desligada, o site continua no
ar com o último dado coletado — e a data da leitura fica visível na página.

## Rodando localmente

```bash
python3 scripts/gerar_exemplo.py     # dados sintéticos
python3 -m http.server 8000          # http://localhost:8000
```

Para coletar dados reais:

```bash
python3 scripts/coletar_pncp.py --dias 90 --uf DF --debug
```

## Decisões que valem registro

**Gráficos escritos à mão em SVG.** Nenhuma biblioteca de charts: o painel
inteiro cabe em um arquivo de ~500 linhas, carrega sem CDN e não quebra quando
uma dependência muda de API. Cada gráfico tem tabela equivalente para leitura
sem cor.

**Procedência declarada na página.** Janela, escopo, critério de classificação
e data da leitura ficam visíveis. Número de contratação pública sem procedência
é número que ninguém pode usar.

**Classificação é triagem.** A separação entre renovação provável e nova
licitação é heurística apoiada no teto de 60 meses do art. 105 da Lei
14.133/2021 — serve para priorizar leitura, não como conclusão jurídica.

## Licença

Código sob licença MIT. Os dados são públicos, do Portal Nacional de
Contratações Públicas.
