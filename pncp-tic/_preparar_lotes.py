import argparse
import json
import math
from pathlib import Path

ESFERAS = {"F": "Federal", "E": "Estadual", "M": "Municipal", "D": "Distrital"}

RAIZ = Path(__file__).resolve().parent
TAMANHO_LOTE = 45


def main():
    parser = argparse.ArgumentParser(description="Corta candidatos TIC em lotes pra julgamento.")
    parser.add_argument("--uf", default="DF", help="sigla da UF (default: DF)")
    parser.add_argument("--esfera", default="F", choices=sorted(ESFERAS), help="F/E/M/D (default: F, Federal)")
    args = parser.parse_args()
    uf = args.uf.upper()
    esfera = args.esfera.upper()
    esfera_nome = ESFERAS[esfera]

    origem = RAIZ / f"resultado_tic_{uf.lower()}_{esfera_nome.lower()}.json"
    if uf == "DF" and esfera == "F":
        pasta_lotes = RAIZ / "julgamento_lotes"
    else:
        pasta_lotes = RAIZ / "julgamento_lotes" / f"{esfera.lower()}_{uf.lower()}"
    pasta_lotes.mkdir(parents=True, exist_ok=True)

    dados = json.loads(origem.read_text(encoding="utf-8"))
    contratos = dados["contratos"]

    n_lotes = math.ceil(len(contratos) / TAMANHO_LOTE)
    print(f"{len(contratos)} contratos -> {n_lotes} lotes de ate {TAMANHO_LOTE} em {pasta_lotes}")

    for i in range(n_lotes):
        fatia = contratos[i * TAMANHO_LOTE : (i + 1) * TAMANHO_LOTE]
        itens = [
            {
                "numero_controle_pncp": c["numero_controle_pncp"],
                "orgao": c["orgao"],
                "objeto": c["objeto"],
            }
            for c in fatia
        ]
        caminho = pasta_lotes / f"lote_{i+1:02d}.json"
        caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"  lote_{i+1:02d}.json: {len(itens)} itens")


if __name__ == "__main__":
    main()
