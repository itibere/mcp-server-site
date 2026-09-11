function ligarToggle(botaoId, painelId) {
  const botao = document.getElementById(botaoId);
  const painel = document.getElementById(painelId);
  if (!botao || !painel) return;
  const chevron = botao.querySelector('.chevron');
  botao.addEventListener('click', () => {
    const expandido = painel.classList.toggle('hidden') === false;
    botao.setAttribute('aria-expanded', String(expandido));
    if (chevron) chevron.classList.toggle('rotate-180', expandido);
  });
}

ligarToggle('toggle-ia', 'lista-ia');
ligarToggle('toggle-seguranca', 'lista-seguranca');
