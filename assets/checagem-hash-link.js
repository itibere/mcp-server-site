const anoEl = document.getElementById('ano');
if (anoEl) anoEl.textContent = new Date().getFullYear();

const API_BASE = "https://vt-proxy.itibere-paquier.workers.dev";

const HASH_RE = /^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$|^[a-fA-F0-9]{128}$/;

const viewForm = document.getElementById('view-form');
const viewLoading = document.getElementById('view-loading');
const viewResult = document.getElementById('view-result');
const loadingDetail = document.getElementById('loading-detail');

const hashInput = document.getElementById('hash-input');
const hashError = document.getElementById('hash-error');
const hashSubmit = document.getElementById('hash-submit');
const attachBtn = document.getElementById('attach-btn');
const attachName = document.getElementById('attach-name');
const fileInput = document.getElementById('file-input');
const hashResetBtn = document.getElementById('hash-reset-btn');

const urlInput = document.getElementById('url-input');
const urlError = document.getElementById('url-error');
const urlSubmit = document.getElementById('url-submit');

function showForm() {
  viewResult.classList.add('hidden');
  viewLoading.classList.add('hidden');
  viewForm.classList.remove('hidden');
}

function showLoading(detail) {
  viewForm.classList.add('hidden');
  viewResult.classList.add('hidden');
  loadingDetail.textContent = detail || 'Consultando VirusTotal...';
  viewLoading.classList.remove('hidden');
}

const BADGE_STYLES = {
  limpo: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  alerta: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  malicioso: 'bg-red-500/10 text-red-400 border-red-500/30',
  erro: 'bg-slate-500/10 text-slate-400 border-slate-500/30',
};
const BADGE_LABELS = {
  limpo: 'LIMPO',
  alerta: 'ALERTA',
  malicioso: 'MALICIOSO',
  erro: 'ERRO',
};
const RESULT_BORDER = {
  limpo: 'border-emerald-800/60 bg-emerald-950/20',
  alerta: 'border-amber-800/60 bg-amber-950/20',
  malicioso: 'border-red-800/60 bg-red-950/20',
  erro: 'border-slate-700/60 bg-slate-900/30',
};

function showResult(status, message, motivos) {
  viewLoading.classList.add('hidden');
  viewForm.classList.add('hidden');

  const section = viewResult;
  section.className = 'rounded-2xl border p-8 space-y-4 ' + (RESULT_BORDER[status] || RESULT_BORDER.erro);

  const badge = document.getElementById('result-badge');
  badge.className = 'px-3 py-1 rounded-full text-xs font-mono-code font-semibold border ' + (BADGE_STYLES[status] || BADGE_STYLES.erro);
  badge.textContent = BADGE_LABELS[status] || BADGE_LABELS.erro;

  document.getElementById('result-message').textContent = message;

  const motivosEl = document.getElementById('result-motivos');
  motivosEl.innerHTML = '';
  if (motivos && motivos.length) {
    motivos.forEach((m) => {
      const li = document.createElement('li');
      li.textContent = m;
      motivosEl.appendChild(li);
    });
    motivosEl.classList.remove('hidden');
  } else {
    motivosEl.classList.add('hidden');
  }

  section.classList.remove('hidden');
}

document.getElementById('result-reset').addEventListener('click', () => {
  hashInput.value = '';
  hashInput.readOnly = false;
  attachName.textContent = '';
  hashResetBtn.classList.add('hidden');
  fileInput.value = '';
  urlInput.value = '';
  validateHash();
  validateUrl();
  showForm();
});

// --- Hash ---

function validateHash() {
  const value = hashInput.value.trim();
  if (!value) {
    hashError.classList.add('hidden');
    hashInput.classList.remove('border-red-500', 'border-emerald-500');
    hashSubmit.disabled = true;
    return false;
  }
  const ok = HASH_RE.test(value);
  hashInput.classList.toggle('border-red-500', !ok);
  hashInput.classList.toggle('border-emerald-500', ok);
  hashError.classList.toggle('hidden', ok);
  if (!ok) hashError.textContent = 'Isso não parece um hash MD5, SHA-1, SHA-256 ou SHA-512 válido (só caracteres hexadecimais).';
  hashSubmit.disabled = !ok;
  return ok;
}
hashInput.addEventListener('input', validateHash);

attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  attachName.textContent = file.name;
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  hashInput.value = hex;
  hashInput.readOnly = true;
  hashResetBtn.classList.remove('hidden');
  validateHash();
});

hashResetBtn.addEventListener('click', () => {
  hashInput.value = '';
  hashInput.readOnly = false;
  attachName.textContent = '';
  fileInput.value = '';
  hashResetBtn.classList.add('hidden');
  validateHash();
  hashInput.focus();
});

hashSubmit.addEventListener('click', async () => {
  if (!validateHash()) return;
  const hash = hashInput.value.trim();
  showLoading('Consultando hash no VirusTotal...');
  try {
    const res = await fetch(API_BASE + '/hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    const data = await res.json();
    if (data.error === 'quota_excedida') {
      showResult('erro', 'Limite diário de consultas ao VirusTotal atingido. Tente novamente mais tarde.');
    } else if (data.error) {
      showResult('erro', 'Não foi possível completar a consulta agora. Tente novamente mais tarde.');
    } else if (data.found === false) {
      showResult('erro', 'Hash não encontrado na base do VirusTotal — arquivo desconhecido, não foi possível confirmar se é seguro.');
    } else {
      showResult(data.status, data.message);
    }
  } catch {
    showResult('erro', 'Falha de conexão com o serviço de verificação. Tente novamente mais tarde.');
  }
});

// --- URL ---

function validateUrl() {
  const value = urlInput.value.trim();
  if (!value) {
    urlError.classList.add('hidden');
    urlInput.classList.remove('border-red-500', 'border-emerald-500');
    urlSubmit.disabled = true;
    return false;
  }
  let ok = true;
  try {
    const withProtocol = /^https?:\/\//i.test(value) ? value : 'https://' + value;
    new URL(withProtocol);
  } catch {
    ok = false;
  }
  urlInput.classList.toggle('border-red-500', !ok);
  urlInput.classList.toggle('border-emerald-500', ok);
  urlError.classList.toggle('hidden', ok);
  if (!ok) urlError.textContent = 'Isso não parece uma URL válida.';
  urlSubmit.disabled = !ok;
  return ok;
}
urlInput.addEventListener('input', validateUrl);

async function pollUrlAnalysis(analysisId, attempt) {
  attempt = attempt || 0;
  if (attempt > 40) {
    showResult('erro', 'A análise demorou mais que o esperado. Tente novamente mais tarde.');
    return;
  }
  try {
    const res = await fetch(API_BASE + '/url/' + encodeURIComponent(analysisId));
    const data = await res.json();
    if (data.error) {
      showResult('erro', 'Não foi possível completar a consulta agora. Tente novamente mais tarde.');
      return;
    }
    if (data.done) {
      const motivos = data.message && data.message.includes('Motivos:')
        ? data.message.split('Motivos:')[1].split(';').map((s) => s.trim()).filter(Boolean)
        : null;
      const baseMessage = data.message.split(' Motivos:')[0];
      showResult(data.status, baseMessage, motivos);
    } else {
      setTimeout(() => pollUrlAnalysis(analysisId, attempt + 1), 3000);
    }
  } catch {
    showResult('erro', 'Falha de conexão com o serviço de verificação. Tente novamente mais tarde.');
  }
}

urlSubmit.addEventListener('click', async () => {
  if (!validateUrl()) return;
  const raw = urlInput.value.trim();
  const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  showLoading('Consultando URL no VirusTotal...');
  try {
    const res = await fetch(API_BASE + '/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (data.error === 'quota_excedida') {
      showResult('erro', 'Limite diário de consultas ao VirusTotal atingido. Tente novamente mais tarde.');
    } else if (data.error) {
      showResult('erro', 'Não foi possível completar a consulta agora. Tente novamente mais tarde.');
    } else if (data.queued) {
      loadingDetail.textContent = 'Análise em andamento, isso pode levar até 2 minutos...';
      pollUrlAnalysis(data.analysis_id);
    } else if (data.done) {
      const motivos = data.message && data.message.includes('Motivos:')
        ? data.message.split('Motivos:')[1].split(';').map((s) => s.trim()).filter(Boolean)
        : null;
      const baseMessage = data.message.split(' Motivos:')[0];
      showResult(data.status, baseMessage, motivos);
    }
  } catch {
    showResult('erro', 'Falha de conexão com o serviço de verificação. Tente novamente mais tarde.');
  }
});
