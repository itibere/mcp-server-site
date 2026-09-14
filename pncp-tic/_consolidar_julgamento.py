import argparse
import json
import unicodedata
from pathlib import Path

ESFERAS = {"F": "Federal", "E": "Estadual", "M": "Municipal", "D": "Distrital"}

RAIZ = Path(__file__).resolve().parent


def slug(nome: str) -> str:
    sem_acento = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode("ascii")
    return "_".join(sem_acento.lower().split())


def main():
    parser = argparse.ArgumentParser(description="Consolida julgamentos nos candidatos originais.")
    parser.add_argument("--uf", default="DF", help="sigla da UF (default: DF)")
    parser.add_argument("--esfera", default="F", choices=sorted(ESFERAS), help="F/E/M/D (default: F, Federal)")
    parser.add_argument("--municipio", default=None, help="mesmo municipio usado em coletar_via_search.py --municipio")
    args = parser.parse_args()
    uf = args.uf.upper()
    esfera = args.esfera.upper()
    esfera_nome = ESFERAS[esfera]
    municipio = args.municipio
    sufixo_municipio = f"_{slug(municipio)}" if municipio else ""

    origem = RAIZ / f"resultado_tic_{uf.lower()}_{esfera_nome.lower()}{sufixo_municipio}.json"
    if uf == "DF" and esfera == "F":
        pasta_lotes = RAIZ / "julgamento_lotes"
    else:
        pasta_lotes = RAIZ / "julgamento_lotes" / f"{esfera.lower()}_{uf.lower()}{sufixo_municipio}"
    saida = RAIZ / f"resultado_tic_{uf.lower()}_{esfera_nome.lower()}{sufixo_municipio}_julgado.json"

    dados = json.loads(origem.read_text(encoding="utf-8"))
    contratos = dados["contratos"]

    julgamentos = {}
    lotes = sorted(pasta_lotes.glob("julgamento_*.json"))
    for caminho in lotes:
        itens = json.loads(caminho.read_text(encoding="utf-8"))
        for it in itens:
            num = it.get("numero_controle_pncp")
            julgamentos[num] = it

    print(f"total de julgamentos coletados: {len(julgamentos)} (esperado: {len(contratos)})")

    faltando = [c["numero_controle_pncp"] for c in contratos if c["numero_controle_pncp"] not in julgamentos]
    if faltando:
        print(f"AVISO: {len(faltando)} contratos sem julgamento (ficam de fora por seguranca): {faltando[:5]}")

    aprovados, reprovados = [], []
    for c in contratos:
        j = julgamentos.get(c["numero_controle_pncp"])
        if j is None:
            continue
        if j["veredito"] == "tic":
            aprovados.append(c)
        else:
            reprovados.append({
                "orgao": c["orgao"],
                "objeto": c["objeto"],
                "motivo": j.get("motivo", ""),
                "numero_controle_pncp": c["numero_controle_pncp"],
            })

    print(f"\naprovados (tic de verdade): {len(aprovados)}")
    print(f"reprovados (falso positivo do filtro de palavra-chave): {len(reprovados)}")

    resultado = dict(dados)
    resultado["contratos"] = aprovados
    resultado["totalVencendoJanela"] = len(aprovados)
    resultado["totalServicos"] = sum(1 for c in aprovados if c.get("eh_servico_texto"))
    resultado["julgamentoAgente"] = {
        "total_antes": len(contratos),
        "aprovados": len(aprovados),
        "reprovados": len(reprovados),
        "exemplosReprovados": reprovados,
    }
    saida.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\ngravado em {saida}")


if __name__ == "__main__":
    main()
