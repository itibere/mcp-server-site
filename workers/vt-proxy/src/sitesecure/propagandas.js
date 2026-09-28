// Existencia de propagandas: quais redes de anuncio a pagina carrega e para
// onde os anuncios levam.
import redes from "./data/redes_anuncio.json";
import { dominioRaiz, hostDe } from "./util.js";

const CONFIAVEIS = new Set(redes.confiaveis);
const ARRISCADAS = new Set(redes.arriscadas);

function casa(conjunto, host) {
  const partes = host.split(".");
  for (let i = 0; i < partes.length - 1; i++) {
    if (conjunto.has(partes.slice(i).join("."))) return true;
  }
  return false;
}

export function detectarRedes(requisicoes, iframes) {
  const confiaveis = new Set();
  const arriscadas = new Set();
  for (const url of [...requisicoes, ...iframes]) {
    const host = hostDe(url);
    if (!host) continue;
    if (casa(ARRISCADAS, host)) arriscadas.add(dominioRaiz(host));
    else if (casa(CONFIAVEIS, host)) confiaveis.add(dominioRaiz(host));
  }
  return { confiaveis: [...confiaveis], arriscadas: [...arriscadas] };
}

// destinos = saida de classificarDestinos; usa so os marcados como anuncio,
// tirando as proprias redes (o clique passa por elas antes do anunciante).
export function avaliarPropagandas(redesDetectadas, destinos, modo) {
  const anunciantes = destinos.filter((d) => d.anuncio && !CONFIAVEIS.has(d.raiz) && !ARRISCADAS.has(d.raiz));
  const ruins = anunciantes.filter((d) => d.nivel === "baixo");
  const bons = anunciantes.filter((d) => d.nivel === "bom");
  const existe = redesDetectadas.confiaveis.length + redesDetectadas.arriscadas.length + anunciantes.length > 0;
  return {
    existe,
    verificavel: modo === "navegador",
    redes: redesDetectadas,
    anunciantes: anunciantes.slice(0, 15).map(({ raiz, nivel, motivo }) => ({ raiz, nivel, motivo })),
    ruins: ruins.length,
    bons: bons.length,
  };
}
