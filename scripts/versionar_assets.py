# -*- coding: utf-8 -*-
"""Poe ?v=<hash do conteudo> nos CSS/JS/imagens locais referenciados pelos HTML
do site. Sem isso o navegador pode seguir ate 4 h com a versao antiga em cache
(Cache-Control: max-age=14400 nos assets).

A versao e os 8 primeiros hex do SHA-256 do arquivo: so muda quando o arquivo
muda, e rodar duas vezes nao altera nada. URLs externas sao ignoradas.

Uso (rodar antes do commit):
    python scripts/versionar_assets.py          # grava
    python scripts/versionar_assets.py --check  # so lista; sai com 1 se houver pendencia
"""
import hashlib
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
IGNORAR_DIRS = {"node_modules", ".wrangler", ".git", ".github", "workers", "pncp-tic", "scripts"}
EXTENSOES = {".css", ".js", ".gif", ".png", ".svg", ".webp", ".ico", ".jpg", ".jpeg"}
REF = re.compile(r'(\b(?:src|href)=")([^"]+)(")')


def listar_html():
    for html in sorted(RAIZ.rglob("*.html")):
        if not IGNORAR_DIRS.intersection(html.relative_to(RAIZ).parts[:-1]):
            yield html


def hash_curto(arquivo, cache={}):
    if arquivo not in cache:
        cache[arquivo] = hashlib.sha256(arquivo.read_bytes()).hexdigest()[:8]
    return cache[arquivo]


def nova_url(url, html):
    """Retorna a URL com ?v= atualizado, ou None se nao for asset local."""
    if re.match(r"^([a-z][a-z0-9+.-]*:|//|#)", url, re.I):
        return None
    caminho, _, resto = url.partition("?")
    query, _, frag = resto.partition("#")
    if "#" in caminho:
        caminho, _, frag = caminho.partition("#")
    if Path(caminho).suffix.lower() not in EXTENSOES:
        return None
    alvo = (RAIZ / caminho.lstrip("/")) if caminho.startswith("/") else (html.parent / caminho)
    alvo = alvo.resolve()
    if not alvo.is_file():
        print(f"  aviso: {html.relative_to(RAIZ)} aponta para arquivo inexistente: {url}")
        return None
    params = [p for p in query.split("&") if p and not p.startswith("v=")]
    params.append("v=" + hash_curto(alvo))
    return caminho + "?" + "&".join(params) + ("#" + frag if frag else "")


def main():
    checar = "--check" in sys.argv[1:]
    pendentes = 0
    for html in listar_html():
        with open(html, encoding="utf-8", newline="") as f:
            texto = f.read()
        mudancas = []

        def trocar(m):
            antiga = m.group(2)
            nova = nova_url(antiga, html)
            if nova is None or nova == antiga:
                return m.group(0)
            mudancas.append((antiga, nova))
            return m.group(1) + nova + m.group(3)

        novo_texto = REF.sub(trocar, texto)
        if not mudancas:
            continue
        pendentes += len(mudancas)
        print(html.relative_to(RAIZ))
        for antiga, nova in mudancas:
            print(f"  {antiga}  ->  {nova}")
        if not checar:
            with open(html, "w", encoding="utf-8", newline="") as f:
                f.write(novo_texto)

    if pendentes == 0:
        print("Tudo em dia.")
    elif checar:
        print(f"{pendentes} referencia(s) desatualizada(s). Rode sem --check para gravar.")
        sys.exit(1)
    else:
        print(f"{pendentes} referencia(s) atualizada(s).")


if __name__ == "__main__":
    main()
