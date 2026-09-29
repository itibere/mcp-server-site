# -*- coding: utf-8 -*-
"""Gera assets/hacker-scan.gif a partir do GIF original (gato no notebook),
apagando o logo da tampa (tampa lisa, sem marca). Mantem as cores
originais e amplia 2x.

Uso: python scripts/trocar_logo_gif.py <origem.gif> [saida.gif]
"""
import statistics
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageSequence

ESCALA = 2
CAIXA = (40, 140, 70, 172)  # regiao do logo na tampa, em px do GIF 220x220


def main():
    origem = Path(sys.argv[1])
    saida = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "assets" / "hacker-scan.gif"

    frames, duracoes = [], []
    for frame in ImageSequence.Iterator(Image.open(origem)):
        duracoes.append(frame.info.get("duration", 100))
        f = frame.convert("RGB")

        # O logo e o unico branco dentro da CAIXA; a tampa se mexe um pouco,
        # entao o centro e recalculado a cada quadro.
        x0, y0, x1, y1 = CAIXA
        logo = [(x, y) for y in range(y0, y1) for x in range(x0, x1) if min(f.getpixel((x, y))) > 170]
        cx = sum(p[0] for p in logo) / len(logo)
        cy = sum(p[1] for p in logo) / len(logo)

        mascara = Image.new("L", f.size, 0)
        ImageDraw.Draw(mascara).point(logo, fill=255)
        mascara = mascara.filter(ImageFilter.MaxFilter(5))
        anel = [f.getpixel((x, y)) for y in range(int(cy) - 11, int(cy) + 12) for x in range(int(cx) - 9, int(cx) + 10)
                if mascara.getpixel((x, y)) == 0]
        tampa = tuple(int(statistics.median(c[i] for c in anel)) for i in range(3))
        f.paste(tampa, mask=mascara)

        f = f.resize((f.width * ESCALA, f.height * ESCALA), Image.LANCZOS)
        frames.append(f.quantize(colors=256, method=Image.MEDIANCUT))

    frames[0].save(saida, save_all=True, append_images=frames[1:], duration=duracoes,
                   loop=0, optimize=True, disposal=1)
    print(f"{saida} {saida.stat().st_size // 1024} KB, {len(frames)} frames")


if __name__ == "__main__":
    main()
