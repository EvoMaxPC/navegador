/** Casos de regresión preparados para la fase 4. No ejecutados en esta entrega. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandFor, normalizeBinding, shortcutConflicts, DEFAULT_BINDINGS, acceleratorFor } from '../src/nav/shortcuts.js';
import { browserPreferences } from '../src/nav/browserPreferences.js';

test('atajos fase 4: eventos DOM y Electron usan la misma tabla', () => {
  assert.equal(commandFor({key:'k',control:true}), 'command-center');
  assert.equal(commandFor({key:'m',ctrlKey:true,shiftKey:true}), 'memory');
  assert.equal(commandFor({key:'f',control:true,shift:true}), 'reader');
  assert.equal(commandFor({key:'ArrowLeft',alt:true}), 'back');
  assert.equal(commandFor({key:'Home',altKey:true}), 'home');
  assert.equal(commandFor({key:'F11'}), 'fullscreen');
});
test('sin captura de texto normal, AltGr ni reserva de editar/sistema', () => {
  assert.equal(commandFor({key:'t'}), null);
  assert.equal(commandFor({key:'q',control:true,alt:true}), null);
  assert.equal(normalizeBinding('Ctrl+C'), null);
  assert.equal(normalizeBinding('Alt+F4'), null);
  assert.equal(normalizeBinding('A'), null);
});
test('conflictos, personalización y restauración', () => {
  assert.deepEqual(shortcutConflicts({}), []);
  assert.ok(shortcutConflicts({history:'Ctrl+J'}).length);
  assert.equal(commandFor({key:'h',control:true},{bindings:{history:''}}), null);
  assert.equal(DEFAULT_BINDINGS.memory, 'Ctrl+Shift+M');
});
test('preferencias acotadas y sin acciones arbitrarias', () => {
  const p=browserPreferences({toolbar:['memory','memory','ejecutar-codigo'],workspaces:[{id:'bad path',name:'No'},{id:'work',name:'Trabajo'}]});
  assert.deepEqual(p.toolbar,['memory']);
  assert.ok(p.workspaces.some(w=>w.id==='main'));
  assert.ok(!p.workspaces.some(w=>w.id==='bad path'));
  assert.throws(()=>browserPreferences({shortcuts:{history:'Ctrl+J'}}));
});
test('contexto: capacidades sólo en main, caducidad y comprobación de fuente', () => {
  const source=readFileSync(new URL('../src/main/advancedBrowser.js',import.meta.url),'utf8');
  assert.match(source,/event.senderFrame === event.sender.mainFrame/);
  assert.match(source,/entry.owner !== sender/);
  assert.match(source,/context.token !== payload.token/);
  assert.match(source,/context.expires < Date.now\(\)/);
  assert.match(source,/context.contents.getURL\(\) !== context.href/);
  assert.match(source,/contexts.delete\(event.sender.id\)/);
});


test('aceleradores macOS preservan Command al convertir la tecla Comma',()=>{
  assert.equal(acceleratorFor('new-tab','darwin'),'Command+T');
  assert.equal(acceleratorFor('settings','darwin'),'Command+,');
  assert.equal(acceleratorFor('settings','linux'),'Ctrl+,');
});
