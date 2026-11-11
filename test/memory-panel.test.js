import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryReadout, createMemoryPanel } from '../src/ui/shell/memoryPanel.js';

test('guardado desactivado y respaldo directo nunca confirman disco', () => {
  assert.equal(memoryReadout({ enabled: false, live: { turns: [1] } }).state, 'disabled');
  const result = memoryReadout({ enabled: true, live: { strategy: 'direct-console-injection', turns: [1] } });
  assert.equal(result.state, 'ram');
  assert.match(result.detail, /no confirma persistencia/);
});
test('la presentación distingue registro consultado de registro no leído', () => {
  assert.equal(memoryReadout({}).state, 'idle');
  const loaded = memoryReadout({ loaded: true, conversations: [{ turns: [] }, { turns: [1] }] });
  assert.equal(loaded.state, 'local');
  assert.match(loaded.detail, /2 conversaciones/);
  assert.match(loaded.detail, /no es una verificación del disco/);
});
test('lectura en curso sólo publica cantidad y no texto ni confirmación de guardado', () => {
  const result = memoryReadout({ live: { streaming: true, turns: [{ content: 'SECRETO' }, {}] } });
  assert.equal(result.title, 'Conversación en curso');
  assert.match(result.detail, /2 mensajes en RAM/);
  assert.ok(!JSON.stringify(result).includes('SECRETO'));
  assert.match(result.detail, /no verifica el archivo/);
});

function fixture() {
  function element(id, name) {
    const classes = new Set(); const attrs = {}; const listeners = {};
    const e = { id, dataset: { memorySection: name }, hidden: false, tabIndex: -1,
      classList: { contains: v => classes.has(v), toggle(v, active = !classes.has(v)) { if (active) classes.add(v); else classes.delete(v); } },
      setAttribute(k, v) { attrs[k] = v; }, getAttribute: k => attrs[k],
      addEventListener(k, fn) { listeners[k] = fn; }, click() { listeners.click?.({}); },
      key(key) { let prevented = false; listeners.keydown?.({ key, preventDefault() { prevented = true; } }); return prevented; },
      focus() { e.focused = true; },
    }; return e;
  }
  const names = ['conversation', 'saved', 'favorites'];
  const tabs = names.map(n => element(`memory-tab-${n}`, n));
  const panes = names.map(n => element(`memory-pane-${n}`));
  const tools = element('tools'), pin = element('pin'), browser = element('browser'); const selected = [];
  const root = { querySelectorAll: selector => selector === '.memory-pane' ? panes : tabs, querySelector: () => tools };
  const panel = createMemoryPanel({ root, browser, pin, onSelect: name => selected.push(name) });
  return { panel, tabs, panes, tools, pin, browser, selected };
}
test('solapas reales: sólo la vista elegida es visible, con aria y continuidad conservada', () => {
  const f = fixture(); f.panel.select('saved');
  assert.equal(f.panel.selected, 'saved');
  assert.deepEqual(f.panes.map(p => p.hidden), [true, false, true]);
  assert.deepEqual(f.tabs.map(t => t.getAttribute('aria-selected')), ['false', 'true', 'false']);
  assert.equal(f.tools.hidden, true);
  f.panel.select('conversation'); assert.equal(f.tools.hidden, false);
  assert.equal(f.tabs[0].tabIndex, 0);
});
test('teclado horizontal y Home/End mantienen foco y selección; no consumen otras teclas', () => {
  const f = fixture();
  assert.equal(f.tabs[0].key('ArrowLeft'), true); assert.equal(f.panel.selected, 'favorites');
  assert.equal(f.tabs[2].focused, true);
  f.tabs[2].key('Home'); assert.equal(f.panel.selected, 'conversation');
  f.tabs[0].key('End'); assert.equal(f.panel.selected, 'favorites');
  f.tabs[2].key('ArrowRight'); assert.equal(f.panel.selected, 'conversation');
  assert.equal(f.tabs[0].key('Escape'), false);
});
test('fijar alterna espacio reservado/superposición, sin cambiar vistas ni datos', () => {
  const f = fixture(); f.pin.click();
  assert.equal(f.browser.classList.contains('panel-floating'), true);
  assert.equal(f.pin.getAttribute('aria-pressed'), 'false');
  assert.equal(f.pin.getAttribute('aria-label'), 'Fijar panel EVO');
  f.pin.click();
  assert.equal(f.browser.classList.contains('panel-floating'), false);
  assert.equal(f.pin.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.selected, []);
});
test('una solapa desconocida no cambia la selección ni ejecuta acciones', () => {
  const f = fixture(); f.panel.select('__proto__');
  assert.equal(f.panel.selected, 'conversation'); assert.deepEqual(f.selected, []);
});

test('disponibilidad EVO requiere interruptor global y preferencia; no cambia los ajustes guardados',async()=>{
 const {isEvoMemoryEnabled}=await import('../src/core/settings.js');for(const [settings,enabled] of [[{},true],[{enabled:false,memory:{enabled:true}},false],[{enabled:true,memory:{enabled:false}},false],[{enabled:true,memory:{enabled:true}},true]]){const before=structuredClone(settings);assert.equal(isEvoMemoryEnabled(settings),enabled);assert.deepEqual(settings,before);}
});
test('panel desactivado oculta sólo EVO y explica que Comprensión sigue activa',async()=>{
 const {setMemoryPanelAvailability}=await import('../src/ui/shell/memoryPanel.js');const notice={hidden:true},calls=[],root={classList:{toggle:(...args)=>calls.push(args)},querySelector:s=>{assert.equal(s,'#memoryDisabledNotice');return notice;}};setMemoryPanelAvailability(root,false);assert.equal(notice.hidden,false);assert.deepEqual(calls[0],['evo-memory-disabled',true]);const readout=memoryReadout({enabled:false,live:{turns:[{content:'privado'}]}});assert.match(readout.detail,/Comprensión sigue activa/);assert.ok(!JSON.stringify(readout).includes('privado'));setMemoryPanelAvailability(root,true);assert.equal(notice.hidden,true);
});
