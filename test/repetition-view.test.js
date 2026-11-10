import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepetitionView } from '../src/ui/shell/repetition.js';

class Element {
  constructor() { this.children = []; this.dataset = {}; this.writes = 0; this.parent = null; this.value = ''; }
  set innerHTML(_value) { throw Error('No interpretar texto de ChatGPT como HTML'); }
  get textContent() { return this.value; }
  set textContent(value) { this.value = value; this.writes++; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, node); node.parent = this;
  }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
}

function view() {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  const list = new Element(), status = new Element(), diagnostics = new Element();
  const scroller = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 };
  return { list, status, diagnostics, scroller, render: createRepetitionView({ list, status, diagnostics, scroller }).render,
    restore: () => { globalThis.document = previous; } };
}
const snapshot = (answer) => ({ turns: [
  { id: 'u', role: 'user', content: '  Pregunta\n' }, { id: 'a', role: 'assistant', content: answer },
] });

test('render literal: ambos roles, espacios/código/Unicode exactos y sin interpretar HTML', () => {
  const h = view();
  try {
    const content = '\n<img onerror=alert(1)> 😊\n  código\n';
    h.render(snapshot(content));
    assert.equal(h.list.children[0].children[0].textContent, 'Vos');
    assert.equal(h.list.children[1].children[0].textContent, 'ChatGPT');
    assert.equal(h.list.children[0].children[1].textContent, '  Pregunta\n');
    assert.equal(h.list.children[1].children[1].textContent, content);
  } finally { h.restore(); }
});

test('el streaming actualiza el nodo existente sin duplicar mensajes ni reescribir texto idéntico', () => {
  const h = view();
  try {
    h.render(snapshot('Parcial')); const item = h.list.children[1];
    h.render(snapshot('Parcial')); assert.equal(item.children[1].writes, 1);
    h.render(snapshot('Parcial y final')); assert.equal(h.list.children[1], item);
    assert.equal(h.list.children.length, 2); assert.equal(item.children[1].textContent, 'Parcial y final');
  } finally { h.restore(); }
});

test('chat vacío limpia mensajes anteriores y el límite nunca se anuncia como copia completa', () => {
  const h = view();
  try {
    h.render({ ...snapshot('recortado'), clipped: true });
    assert.match(h.status.textContent, /no es la conversación completa/);
    h.render(null, 'Sin conversación'); assert.equal(h.list.children.length, 0);
    assert.equal(h.status.textContent, 'Sin conversación');
  } finally { h.restore(); }
});

test('no fuerza el scroll si el usuario está leyendo mensajes anteriores', () => {
  const h = view();
  try {
    h.scroller.scrollTop = 10;
    h.render(snapshot('Nuevo texto')); assert.equal(h.scroller.scrollTop, 10);
    h.scroller.scrollTop = 600;
    h.render(snapshot('Más texto')); assert.equal(h.scroller.scrollTop, 1000);
  } finally { h.restore(); }
});

test('el diagnóstico diferencia falta de conexión de una lectura activa sin mensajes', () => {
  const h = view();
  try {
    h.render(null);
    assert.match(h.diagnostics.textContent, /no se recibió ningún snapshot/);
    h.render({ strategy: 'none', turns: [] });
    assert.match(h.diagnostics.textContent, /ninguna detectada/);
    assert.doesNotMatch(h.diagnostics.textContent, /no se recibió/);
  } finally { h.restore(); }
});
