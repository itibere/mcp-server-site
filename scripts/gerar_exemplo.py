"""
Gera projetos/pncp/dados.json com dados SINTÉTICOS, marcados como exemplo.

Serve para o site ficar completo e navegável antes de existir uma coleta real.
Assim que o coletor rodar, ele sobrescreve o mesmo arquivo com `exemplo: false`
e o aviso some sozinho da página.

Uso:  python3 scripts/gerar_exemplo.py
"""

from __future__ import annotations

import json
import pathlib
import random
from datetime import date, datetime, timedelta, timezone

from montar import montar

SAIDA = pathlib.Path(__file__).resolve().parent.parent / "projetos" / "pncp" / "dados.json"

ORGAOS = [
    ("Órgão federal A — administração direta", "00000000000191"),
    ("Órgão federal B — autarquia", "00000000000272"),
    ("Órgão federal C — administração direta", "00000000000353"),
    ("Órgão federal D — empresa pública", "00000000000434"),
    ("Órgão federal E — autarquia", "00000000000515"),
    ("Órgão federal F — administração direta", "00000000000696"),
    ("Órgão federal G — fundação", "00000000000777"),
    ("Órgão federal H — autarquia", "00000000000858"),
    ("Órgão federal I — administração direta", "00000000000939"),
    ("Órgão federal J — empresa pública", "00000000001010"),
    ("Órgão federal K — fundação", "00000000001101"),
    ("Órgão federal L — autarquia", "00000000001202"),
]

MODALIDADES = [
    ("Pregão Eletrônico", 0.58),
    ("Dispensa", 0.22),
    ("Inexigibilidade", 0.11),
    ("Concorrência Eletrônica", 0.09),
]

OBJETOS = [
    "Aquisição de switches de acesso e agregação para modernização do parque de rede",
    "Contratação de serviço continuado de suporte a solução de firewall de próxima geração",
    "Renovação de subscrição de solução de antivírus corporativo (endpoint)",
    "Contratação de link de comunicação de dados com garantia de banda",
    "Aquisição de licenças de software de virtualização de servidores",
    "Serviço de sustentação de infraestrutura de TIC com repasse de conhecimento",
    "Aquisição de estações de trabalho e monitores para substituição de parque",
    "Contratação de solução de backup em nuvem com retenção estendida",
    "Serviço especializado de operação de central de serviços (service desk)",
    "Aquisição de nobreaks e infraestrutura elétrica para sala de equipamentos",
    "Contratação de solução de gestão de identidade e acesso privilegiado",
    "Serviço de desenvolvimento e sustentação de sistemas sob demanda",
    "Aquisição de solução de monitoramento de infraestrutura e aplicações",
    "Contratação de serviço de telefonia IP e comunicação unificada",
    "Aquisição de storage corporativo com serviço de instalação e garantia",
    "Contratação de consultoria em segurança da informação e testes de intrusão",
]


def escolher_modalidade(rnd: random.Random) -> str:
    x, acumulado = rnd.random(), 0.0
    for nome, peso in MODALIDADES:
        acumulado += peso
        if x <= acumulado:
            return nome
    return MODALIDADES[0][0]


def valor_sintetico(rnd: random.Random) -> float:
    # Cauda longa: muita contratação pequena, poucas muito grandes.
    escala = rnd.choices([1, 2, 3, 4], weights=[38, 34, 20, 8])[0]
    base = {1: (8_000, 50_000), 2: (50_000, 250_000),
            3: (250_000, 1_000_000), 4: (1_000_000, 12_000_000)}[escala]
    return round(rnd.uniform(*base), -2)


def main() -> None:
    rnd = random.Random(20260826)
    fim = date(2026, 8, 25)
    inicio = fim - timedelta(days=89)

    registros = []
    for _ in range(214):
        orgao, cnpj = rnd.choice(ORGAOS)
        dia = inicio + timedelta(days=rnd.randint(0, (fim - inicio).days))
        if dia.weekday() >= 5:                      # publicação é dia útil
            dia -= timedelta(days=dia.weekday() - 4)
        tem_valor = rnd.random() > 0.09             # nem tudo traz valor estimado
        registros.append({
            "data": dia.isoformat(),
            "orgao": orgao,
            "cnpj": cnpj,
            "uf": "DF",
            "objeto": rnd.choice(OBJETOS),
            "modalidade": escolher_modalidade(rnd),
            "valor": valor_sintetico(rnd) if tem_valor else 0,
            "link": "",
            "origem": "categoria" if rnd.random() > 0.28 else "palavra-chave",
        })

    dados = montar(
        registros,
        cobertura={
            "inicio": inicio.isoformat(),
            "fim": fim.isoformat(),
            "ufs": ["DF"],
            "esfera": "Federal",
            "modalidades": [nome for nome, _ in MODALIDADES],
            "criterio_tic": "categoria oficial de TIC + resgate por palavra-chave no objeto",
            "fonte": "Portal Nacional de Contratações Públicas (dados abertos)",
        },
        gerado_em=datetime.now(timezone(timedelta(hours=-3))).isoformat(timespec="seconds"),
        exemplo=True,
    )

    SAIDA.parent.mkdir(parents=True, exist_ok=True)
    SAIDA.write_text(json.dumps(dados, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{SAIDA}: {len(dados['registros'])} registros sintéticos")


if __name__ == "__main__":
    main()
