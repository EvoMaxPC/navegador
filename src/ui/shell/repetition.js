/** Vista literal: sólo textContent, sin Markdown/HTML ejecutable ni resúmenes. */
export function createRepetitionView({ list, status, scroller }) {
  const rows = new Map();
  return {
    render(snapshot, emptyMessage = 'Todavía no hay mensajes cargados en esta conversación.') {
      const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 70;
      const turns = snapshot?.turns || [];
      const keep = new Set();
      for (const [index, turn] of turns.entries()) {
        const key = `${index}:${turn.role}:${turn.id}`;
        keep.add(key);
        let row = rows.get(key);
        if (!row) {
          const item = document.createElement('li');
          item.className = `repeat-message ${turn.role === 'user' ? 'from-user' : 'from-assistant'}`;
          const role = document.createElement('h3');
          role.textContent = turn.role === 'user' ? 'Vos' : 'ChatGPT';
          const text = document.createElement('pre'); text.className = 'repeat-text';
          item.append(role, text);
          row = { item, text }; rows.set(key, row);
        }
        if (row.text.textContent !== turn.content) row.text.textContent = turn.content;
        const position = list.children[index];
        if (position !== row.item) list.insertBefore(row.item, position || null);
      }
      for (const [key, row] of rows) if (!keep.has(key)) { row.item.remove(); rows.delete(key); }
      status.textContent = !turns.length ? emptyMessage : snapshot.clipped
        ? 'Vista limitada por tamaño o cantidad. Hay mensajes recortados u omitidos; no es la conversación completa.'
        : `${turns.length} mensajes cargados · ${snapshot.streaming ? 'ChatGPT está respondiendo' : 'Lectura automática activa'}`;
      status.dataset.limited = String(Boolean(snapshot?.clipped));
      if (follow) scroller.scrollTop = scroller.scrollHeight;
    },
  };
}
