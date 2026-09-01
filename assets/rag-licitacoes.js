// RAG-LICITAÇÕES — chat frontend. Sem framework, sem estado de conversa
// multi-turno (cada pergunta é independente, ver plano/README do worker).
const WORKER_URL = 'https://rag-licitacoes.itibere-paquier.workers.dev';

const log = document.getElementById('chat-log');
const empty = document.getElementById('chat-empty');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const sendBtn = document.getElementById('chat-send');

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

function addUserMessage(texto) {
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble"></div>`;
  el.querySelector('.bubble').textContent = texto;
  log.appendChild(el);
  scrollToEnd();
}

function addTypingIndicator() {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.id = 'typing-indicator';
  el.innerHTML = `<div class="bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>`;
  log.appendChild(el);
  scrollToEnd();
  return el;
}

function addAssistantMessage(texto, fontes, isError) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (isError ? ' erro' : '');
  bubble.textContent = texto;
  el.appendChild(bubble);

  if (fontes && fontes.length) {
    const fontesEl = document.createElement('div');
    fontesEl.className = 'fontes';
    fontes.forEach((f) => {
      const chip = document.createElement('span');
      chip.className = 'fonte-chip';
      const rotulo = [f.numero, f.ano].filter(Boolean).join('/');
      chip.textContent = rotulo || f.norma_slug || 'fonte';
      if (f.url_fonte) {
        const a = document.createElement('a');
        a.href = f.url_fonte;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = chip.textContent;
        a.style.color = 'inherit';
        chip.textContent = '';
        chip.appendChild(a);
      }
      fontesEl.appendChild(chip);
    });
    el.appendChild(fontesEl);
  }

  log.appendChild(el);
  scrollToEnd();
}

async function perguntar(pergunta) {
  if (!WORKER_URL) {
    addAssistantMessage(
      'Backend do chat ainda não foi configurado (WORKER_URL vazio em assets/rag-licitacoes.js). Isso é esperado até o Cloudflare Worker ser publicado.',
      null,
      true
    );
    return;
  }

  const typingEl = addTypingIndicator();
  try {
    const resp = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pergunta }),
    });
    typingEl.remove();

    if (!resp.ok) {
      const texto = await resp.text().catch(() => '');
      addAssistantMessage(`Erro ${resp.status} ao consultar o backend. ${texto.slice(0, 200)}`, null, true);
      return;
    }

    const dados = await resp.json();
    addAssistantMessage(dados.resposta || '(resposta vazia)', dados.fontes || []);
  } catch (err) {
    typingEl.remove();
    addAssistantMessage(`Falha de rede ao consultar o backend: ${err.message}`, null, true);
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const texto = input.value.trim();
  if (!texto) return;
  addUserMessage(texto);
  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  perguntar(texto).finally(() => {
    sendBtn.disabled = false;
    input.focus();
  });
});

// Enter envia, Shift+Enter quebra linha
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    form.requestSubmit();
  }
});

// Auto-resize da textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
});
