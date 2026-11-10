import { resolveInput } from '../../nav/url.js';

// Sin IPC ni acceso al perfil: la nueva pestaña sólo inicia una navegación.
document.getElementById('startSearch').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = resolveInput(document.getElementById('searchInput').value);
  if (!target) return;
  try {
    if (!['https:', 'http:'].includes(new URL(target).protocol)) return;
    location.assign(target);
  } catch { /* Entrada no navegable. */ }
});

const moreApps = document.getElementById('moreApps');
moreApps.addEventListener('click', () => {
  const open = moreApps.getAttribute('aria-expanded') !== 'true';
  moreApps.setAttribute('aria-expanded', String(open));
  document.getElementById('appsList').hidden = !open;
});
