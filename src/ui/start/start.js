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
