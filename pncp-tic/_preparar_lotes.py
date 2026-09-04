import json
import math
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
ORIGEM = RAIZ / "resultado_tic_df_federal.json"
PASTA_LOTES = RAIZ / "julgamento_lotes"
PASTA_LOTES.mkdir(exist_ok=True)

TAMANHO_LOTE = 45

dados = json.loads(ORIGEM.read_text(encoding="utf-8"))
contratos = dados["contratos"]

n_lotes = math.ceil(len(contratos) / TAMANHO_LOTE)
print(f"{len(contratos)} contratos -> {n_lotes} lotes de ate {TAMANHO_LOTE}")

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
    caminho = PASTA_LOTES / f"lote_{i+1:02d}.json"
    caminho.write_text(json.dumps(itens, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  lote_{i+1:02d}.json: {len(itens)} itens")
