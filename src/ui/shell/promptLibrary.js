/**
 * Atajos de conversación: biblioteca local de plantillas del usuario.
 *
 * Insertan texto en el cuadro del sitio para revisarlo antes de enviar; nunca
 * envían solos. Sin red: la lista viene del perfil local por IPC de la shell.
 */
import { fillPrompt, MAX_PROMPT_TEXT, MAX_PROMPT_TITLE, promptVariables, PROMPT_VARIABLES, validatePrompt } from '../../core/prompts.js';

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label, className, onClick) => {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
};
const VARIABLE_HINTS = {
  seleccion: 'el texto que tengas seleccionado en la página',
  pestana: 'el título de la pestaña activa',
  sitio: 'el sitio de la pestaña activa',
  fecha: 'la fecha de hoy',
};

export function createPromptLibrary({ root, nexo, activeTab, insertText, selectedText, notice, onChanged }) {
  let items = [];
  let editing = null;
  // 'list' | 'edit': un refresco de fondo no puede borrar lo que la persona
  // está escribiendo (el panel se refresca al activarse y ante cambios).
  let view = 'list';
  let status = null;

  /**
   * La selección vive en la página, no en la shell: `window.getSelection()` de
   * la shell siempre está vacía y un webview no expone `getSelectedText()`.
   * Se pide al proceso principal, que la lee del contenido real de la pestaña.
   */
  async function selectionText() {
    try {
      const text = String((await selectedText?.()) || '').trim();
      if (text) return text;
    } catch { /* la selección es opcional */ }
    return '';
  }
  async function values() {
    const tab = activeTab();
    return {
      seleccion: await selectionText(),
      pestana: tab?.title || '',
      sitio: (() => { try { return new URL(tab?.url || '').hostname; } catch { return ''; } })(),
      fecha: new Date().toLocaleDateString('es-AR'),
    };
  }
  async function run(item) {
    const filled = fillPrompt(item.text, await values());
    if (filled.missing.length) {
      notice(`Completá ${filled.missing.map((name) => `{{${name}}}`).join(', ')} antes de enviar: el texto se inserta tal cual.`);
    }
    const result = await insertText(filled.text);
    if (!result?.ok) notice(result?.error || 'No se pudo insertar el atajo en el cuadro del sitio.');
    else if (filled.missing.length) notice('Atajo insertado. Revisá las variables pendientes y editá antes de enviar.');
    else notice('Atajo insertado en el cuadro. No se envió: revisalo y pulsá Enviar.');
  }
  function render() {
    view = 'list';
    root.replaceChildren();
    const header = element('div', 'prompt-head');
    header.append(element('h2', '', 'Atajos de conversación'));
    header.append(button('Nuevo atajo', 'hub-primary', () => edit(null)));
    root.append(header);
    root.append(element('p', 'note', 'Plantillas propias para la IA. Se insertan en el cuadro del sitio; nunca se envían solas, no se sincronizan y quedan sólo en este perfil.'));
    status = element('p', 'prompt-status', items.length ? `${items.length} atajos guardados.` : 'Todavía no hay atajos.');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    root.append(status);
    if (!items.length) {
      root.append(element('p', 'note', 'Un atajo puede ser una instrucción con tu estilo («Respondé en 5 puntos, sin relleno») o una plantilla con {{seleccion}} para reutilizar lo que seleccionaste.'));
    }
    const list = element('div', 'prompt-list');
    for (const item of items) {
      const row = element('div', 'prompt-row');
      const main = button('', 'prompt-main', () => run(item));
      main.append(element('strong', '', item.title));
      const used = promptVariables(item.text);
      const preview = item.text.replace(/\s+/g, ' ').slice(0, 120);
      main.append(element('small', '', preview + (item.text.length > 120 ? '…' : '')));
      if (used.length) main.append(element('span', 'prompt-vars', used.map((name) => `{{${name}}}`).join(' ')));
      main.title = `Insertar «${item.title}» en el cuadro del sitio`;
      const tools = element('span', 'prompt-tools');
      tools.append(
        button('Editar', 'icon-label', () => edit(item)),
        button('Eliminar', 'icon-label', async () => {
          const result = await nexo.prompts.remove(item.id);
          if (!result?.ok) notice(result?.error || 'No se pudo eliminar el atajo.');
          else { items = result.items; render(); onChanged?.(items); }
        }),
      );
      row.append(main, tools);
      list.append(row);
    }
    root.append(list);
  }
  function edit(item) {
    editing = item;
    view = 'edit';
    root.replaceChildren();
    const form = element('form', 'prompt-form');
    // La validación nativa (`required`, `maxlength`) corre antes que este
    // manejador; acá sólo se guarda y se evita que el formulario navegue.
    form.addEventListener('submit', (event) => { event.preventDefault(); save(); });
    form.append(element('h2', '', item ? 'Editar atajo' : 'Nuevo atajo'));
    const title = element('input');
    title.type = 'text';
    title.maxLength = MAX_PROMPT_TITLE;
    title.required = true;
    title.value = item?.title || '';
    title.setAttribute('aria-label', 'Nombre del atajo');
    const text = element('textarea');
    text.rows = 7;
    text.maxLength = MAX_PROMPT_TEXT;
    text.required = true;
    text.value = item?.text || '';
    text.setAttribute('aria-label', 'Texto del atajo');
    const hint = element('p', 'note', 'Variables disponibles: {{seleccion}}, {{pestana}}, {{sitio}}, {{fecha}}. Se reemplazan al insertar; las que falten quedan visibles para completarlas.');
    const error = element('p', 'prompt-error');
    error.setAttribute('role', 'alert');
    const actions = element('div', 'prompt-actions');
    actions.append(
      button('Cancelar', 'icon-label', () => render()),
      (() => { const save = element('button', 'hub-primary', 'Guardar'); save.type = 'submit'; return save; })(),
    );
    form.append(
      element('label', 'prompt-field', 'Nombre'), title,
      element('label', 'prompt-field', 'Texto'), text,
      hint,
    );
    const chips = element('div', 'prompt-chips');
    for (const name of PROMPT_VARIABLES) {
      chips.append(button(`{{${name}}} · ${VARIABLE_HINTS[name]}`, 'icon-label', () => {
        text.setRangeText(`{{${name}}}`, text.selectionStart ?? text.value.length, text.selectionEnd ?? text.value.length, 'end');
        text.focus();
      }));
    }
    form.append(chips, error, actions);
    root.append(form);
    title.focus();

    async function save() {
      const valid = validatePrompt({ title: title.value, text: text.value });
      if (!valid.ok) { error.textContent = valid.error; return; }
      error.textContent = '';
      const result = await nexo.prompts.save({ id: editing?.id, ...valid.value });
      if (!result?.ok) { error.textContent = result?.error || 'No se pudo guardar el atajo.'; return; }
      items = result.items;
      notice(editing ? 'Atajo actualizado.' : 'Atajo guardado.');
      onChanged?.(items);
      render();
    }
  }
  return {
    async load() {
      try {
        const result = await nexo.prompts.list();
        items = result?.ok ? result.items : [];
        if (!result?.ok) notice(result?.error || 'No se pudieron cargar los atajos.');
      } catch {
        items = [];
        notice('No se pudieron cargar los atajos.');
        return;
      }
      // Con el formulario abierto sólo se refrescan los datos: el DOM de la
      // edición se conserva intacto.
      if (view === 'edit') return;
      render();
    },
    render,
    get items() { return items; },
    async runById(id) {
      const item = items.find((row) => row.id === id);
      if (item) await run(item);
    },
  };
}
