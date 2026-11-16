// Partes de texto del último mensaje del usuario en un cuerpo de chat.
//
// Vive aparte porque lo usan los dos lados del guardián: la capa inyectada
// (antes de enviar) y el proceso principal (red de seguridad en la red). Si cada
// uno tuviera su copia, un cambio en el formato del cuerpo haría que uno viera el
// mensaje y el otro no, y la discrepancia sería invisible.
//
// Este módulo es genérico a propósito: no nombra proveedores. La forma del cuerpo
// (`messages[].author.role` + `content.parts` / `content.text`) es la del
// protocolo de conversación, no la de un sitio.

/**
 * El cuerpo puede traer `content.parts` como array mixto: strings junto a
 * objetos (imágenes, archivos). Sólo los strings son texto del mensaje; el resto
 * se ignora. Se mira únicamente el último mensaje de rol `user`: los anteriores
 * son historial y no salen en esta petición.
 *
 * @param {unknown} payload cuerpo ya parseado
 * @returns {string[]} partes de texto, en orden; `[]` si no hay ninguna
 */
export function guardSlots(payload) {
  const mensajes = payload?.messages;
  if (!Array.isArray(mensajes)) return [];
  for (let i = mensajes.length - 1; i >= 0; i -= 1) {
    if (mensajes[i]?.author?.role !== 'user') continue;
    const partes = mensajes[i]?.content?.parts;
    if (Array.isArray(partes)) return partes.filter((p) => typeof p === 'string' && p.length > 0);
    const texto = mensajes[i]?.content?.text;
    if (typeof texto === 'string' && texto.length) return [texto];
    return [];
  }
  return [];
}
