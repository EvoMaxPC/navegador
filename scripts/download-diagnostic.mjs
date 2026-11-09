/** Clasifica errores de descarga, incluido el `cause` de fetch en Node. */
export function downloadFailure(error) {
  let current = error;
  const seen = new Set();
  let network = false;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code || '');
    const message = String(current.message || current);
    if (/CERT_|CERTIFICATE|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED/i.test(`${code} ${message}`)) return 'tls';
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|socket hang up|getaddrinfo|fetch failed/i.test(`${code} ${message}`)) network = true;
    current = current.cause;
  }
  return network ? 'network' : null;
}
