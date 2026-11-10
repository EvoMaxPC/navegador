/** Árbol DOM mínimo para callbacks del panel; no prueba visual de navegador. */
export class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.scrollTop = 0;
    this.value = '';
    this.ownText = '';
    this.classList = {
      contains: (c) => this.className.split(' ').includes(c),
      add: (c) => {
        this.className += ` ${c}`;
      },
      toggle: () => {},
    };
  }
  set textContent(t) {
    this.ownText = String(t);
    this.children = [];
  }
  get textContent() {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(_) {
    throw Error('No HTML sin escapar en el panel');
  }
  append(...items) {
    this.children.push(...items);
  }
  prepend(...items) {
    this.children.unshift(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.ownText = '';
  }
  setAttribute(k, v) {
    this[k] = v;
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  querySelectorAll(selector) {
    const tags = selector.split(',');
    const match = (n) =>
      tags.includes(n.tagName) ||
      (selector === '[data-understanding-draft]' &&
        n.dataset.understandingDraft);
    return this.children.flatMap((c) => [
      ...(match(c) ? [c] : []),
      ...c.querySelectorAll(selector),
    ]);
  }
  async fire(name) {
    await this.listeners.get(name)?.({ preventDefault() {} });
  }
}
