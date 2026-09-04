import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
PASTA_LOTES = RAIZ / "julgamento_lotes"
ORIGEM = RAIZ / "resultado_tic_df_federal.json"
SAIDA = RAIZ / "resultado_tic_df_federal_julgado.json"

dados = json.loads(ORIGEM.read_text(encoding="utf-8"))
contratos = dados["contratos"]

julgamentos = {}
lotes = sorted(PASTA_LOTES.glob("julgamento_*.json"))
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
SAIDA.write_text(json.dumps(resultado, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\ngravado em {SAIDA}")
