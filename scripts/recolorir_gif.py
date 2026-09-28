# -*- coding: utf-8 -*-
"""Gera assets/hacker-scan.gif: o GIF de origem em duotone nas cores do site
(fundo #05070c, luz emerald/cyan) com vinheta radial fundindo a borda no fundo.

Uso: python scripts/recolorir_gif.py <origem.gif> [saida.gif]
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps, ImageSequence

FUNDO = (5, 7, 12)        # bg da pagina (#05070c)
MEIO = (6, 95, 70)        # emerald-800
LUZ = (110, 231, 183)     # emerald-300
TAMANHO = 300


def vinheta(tamanho):
    """Mascara radial: 255 no centro, 0 nas bordas."""
    mascara = Image.new("L", (tamanho, tamanho), 0)
    margem = int(tamanho * 0.08)
    ImageDraw.Draw(mascara).ellipse((margem, margem, tamanho - margem, tamanho - margem), fill=255)
    return mascara.filter(ImageFilter.GaussianBlur(tamanho * 0.12))


def main():
    origem = Path(sys.argv[1])
    saida = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "assets" / "hacker-scan.gif"

    gif = Image.open(origem)
    mascara = vinheta(TAMANHO)
    fundo = Image.new("RGB", (TAMANHO, TAMANHO), FUNDO)
    frames, duracoes = [], []

    for frame in ImageSequence.Iterator(gif):
        cinza = frame.convert("L").resize((TAMANHO, TAMANHO), Image.LANCZOS)
        # O GIF original tem fundo claro: inverter faz o fundo virar escuro e as
        # linhas/texto das telas virarem luz, como um terminal.
        cinza = ImageOps.autocontrast(ImageOps.invert(cinza), cutoff=1)
        duo = ImageOps.colorize(cinza, black=FUNDO, mid=MEIO, white=LUZ)
        # Scanlines leves, no mesmo clima do bg-grid-cyber da home.
        linhas = Image.new("L", (TAMANHO, TAMANHO), 255)
        desenho = ImageDraw.Draw(linhas)
        for y in range(0, TAMANHO, 3):
            desenho.line((0, y, TAMANHO, y), fill=200)
        duo = ImageChops.multiply(duo, Image.merge("RGB", (linhas, linhas, linhas)))
        frames.append(Image.composite(duo, fundo, mascara).quantize(colors=48, method=Image.MEDIANCUT))
        duracoes.append(frame.info.get("duration", gif.info.get("duration", 80)))

    frames[0].save(saida, save_all=True, append_images=frames[1:], duration=duracoes,
                   loop=0, optimize=True, disposal=1)
    print(f"{saida} {saida.stat().st_size // 1024} KB, {len(frames)} frames")


if __name__ == "__main__":
    main()
