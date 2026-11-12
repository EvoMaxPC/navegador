import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { mkdtempSync, readFileSync as readFile, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PROMPTS,
  PROMPT_VARIABLES,
  fillPrompt,
  promptVariables,
  sanitizePrompts,
  validatePrompt,
} from '../src/core/prompts.js';
import { PromptStore } from '../src/main/promptStore.js';

// El cargador de Electron falso debe registrarse antes de importar nada que
// dependa de `electron` (el Store y el proceso principal).
register('./harness/loader.mjs', import.meta.url);
const { journal } = await import('./harness/electron-stub.mjs');
const { Store } = await import('../src/main/store.js');
await import('../src/main/main.js');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/* ---------------------------- validación ---------------------------- */

test('un atajo exige nombre y texto, sin recortar el contenido', () => {
  assert.equal(validatePrompt({}).ok, false);
  assert.equal(validatePrompt({ title: '  ', text: 'hola' }).ok, false);
  assert.equal(validatePrompt({ title: 'Regla', text: '   ' }).ok, false);
  assert.equal(validatePrompt({ title: 'Regla', text: 'x'.repeat(4001) }).ok, false);
  const ok = validatePrompt({ title: '  Estilo  ', text: '  Respondé breve.\n' });
  assert.deepEqual(ok.value, { title: 'Estilo', text: 'Respondé breve.' });
  // Los espacios internos y los saltos no se normalizan.
  const inner = validatePrompt({ title: 'a', text: 'uno  dos\n\ntres   ' });
  assert.equal(inner.value.text, 'uno  dos\n\ntres');
});

test('el relleno reemplaza sólo variables admitidas y no inventa valores', () => {
  const text = 'Resumí: {{seleccion}}\nPestaña: {{ pestana }} · {{inventada}}';
  const filled = fillPrompt(text, { seleccion: 'texto elegido', pestana: 'Docs' });
  assert.equal(filled.text, 'Resumí: texto elegido\nPestaña: Docs · {{inventada}}');
  assert.deepEqual(filled.missing, []);
  assert.deepEqual(filled.unknown, ['inventada']);

  const missing = fillPrompt('{{seleccion}} y {{fecha}}', { fecha: '9/11/2026' });
  assert.equal(missing.text, '{{seleccion}} y 9/11/2026');
  assert.deepEqual(missing.missing, ['seleccion']);
  // Sin valores válidos no se borra nada: queda visible para completar.
  assert.equal(fillPrompt('{{seleccion}}', { seleccion: '' }).text, '{{seleccion}}');
  assert.equal(fillPrompt('{{seleccion}}', { seleccion: 42 }).text, '{{seleccion}}');
  assert.deepEqual(promptVariables('{{a}} {{b}} {{a}}'), ['a', 'b']);
  assert.deepEqual(PROMPT_VARIABLES, ['seleccion', 'pestana', 'sitio', 'fecha']);
});

test('la lista del perfil se acota y descarta filas inválidas sin confiar en la interfaz', () => {
  const list = sanitizePrompts([
    { id: 'p-abcdef12', title: 'Uno', text: 'texto' },
    { id: '../../etc', title: 'Ruta', text: 'texto' },
    { title: '', text: 'x' },
    null,
    'texto',
    { title: 'Sin id', text: 'válido' },
  ]);
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'p-abcdef12');
  assert.equal(list[1].id, null, 'un id con ruta se descarta aunque el texto sea válido');
  assert.equal(sanitizePrompts(new Array(MAX_PROMPTS + 20).fill({ title: 'x', text: 'y' })).length, MAX_PROMPTS);
  assert.deepEqual(sanitizePrompts('no es lista'), []);
});

/* --------------------------- persistencia --------------------------- */

function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'nexo-prompts-'));
  return { dir, file: join(dir, 'perfil.json') };
}
function stubStore(file) {
  return new Store({ file, fs: undefined });
}

test('guardar, editar, reordenar y eliminar persisten en disco con escritura atómica', () => {
  const { file } = profile();
  const store = stubStore(file);
  let n = 0;
  const prompts = new PromptStore({ store, now: () => 1000 + (n += 1), id: () => `p-test${n}` });
  const a = prompts.save({ title: 'Estilo', text: 'Sin relleno.' });
  assert.equal(a.ok, true);
  assert.equal(a.items.length, 1);
  const b = prompts.save({ title: 'Resumen', text: 'Resumí en 5 puntos.' });
  assert.equal(b.items.length, 2);
  // Editar el mismo id no agrega filas.
  const edited = prompts.save({ id: a.items[0].id, title: 'Estilo v2', text: 'Sin relleno, en tercera persona.' });
  assert.equal(edited.items.length, 2);
  assert.equal(edited.items[0].title, 'Estilo v2', 'editar reemplaza la fila, no agrega otra');
  assert.equal(edited.items[1].title, 'Resumen');
  const order = [edited.items[1].id, edited.items[0].id];
  assert.equal(prompts.reorder(order).ok, true);
  assert.deepEqual(prompts.list.map((row) => row.id), order);
  assert.equal(prompts.reorder(['p-inexistente1']).ok, false, 'un orden ajeno no se aplica');
  assert.equal(prompts.remove(order[0]).ok, true);
  assert.equal(prompts.list.length, 1);
  assert.equal(prompts.remove('p-inexistente1').ok, false);

  const disk = JSON.parse(readFile(file, 'utf8'));
  assert.equal(disk.settings.prompts.items.length, 1);
  assert.equal(disk.settings.prompts.items[0].title, 'Estilo v2', 'el disco refleja la última edición');
  // Un archivo temporal no debe quedar tras el guardado exitoso.
  assert.equal(existsSync(file + '.tmp'), false);
});

test('si el disco falla no se publica un estado falso ni se pierde el perfil anterior', () => {
  const { dir, file } = profile();
  const broken = {
    readFileSync: () => { const error = new Error('sin permiso'); error.code = 'EACCES'; throw error; },
    ...Object.fromEntries(['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync', 'copyFileSync'].map((name) => [name, () => 0])),
    constants: { COPYFILE_EXCL: 1 },
  };
  const store = new Store({ file, fs: broken });
  assert.equal(store.loadStatus.state, 'unreadable');
  const prompts = new PromptStore({ store });
  assert.throws(() => prompts.save({ title: 'x', text: 'y' }), /Perfil no guardado|No se pudo guardar/);
  assert.deepEqual(prompts.list, [], 'no se inventa una lista guardada');
  assert.equal(existsSync(file), false);
  assert.ok(dir);
});

test('si el perfil es de sólo lectura el guardado falla con error y sin mutar RAM', () => {
  const { file } = profile();
  writeFileSync(file, JSON.stringify({ settings: { prompts: { items: [{ id: 'p-aaaaaa11', title: 'A', text: 'B' }] } }, log: [] }));
  const real = new Store({ file });
  const original = structuredClone(real.settings);
  const failingFs = {
    ...Object.fromEntries(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'copyFileSync', 'readFileSync'].map((name) => [name, () => { throw Object.assign(new Error('sólo lectura'), { code: 'EROFS' }); }])),
    constants: { COPYFILE_EXCL: 1 },
  };
  const diskWritable = new Store({ file, fs: { ...failingFs, readFileSync: real.fs.readFileSync, copyFileSync: real.fs.copyFileSync, constants: { COPYFILE_EXCL: 1 } } });
  // El archivo previo sigue intacto tras el fallo.
  const before = readFile(file, 'utf8');
  assert.throws(() => diskWritable.setSettings({ prompts: { items: [{ id: 'p-bbbbbb22', title: 'C', text: 'D' }] } }));
  assert.equal(readFile(file, 'utf8'), before);
  assert.deepEqual(diskWritable.settings, structuredClone(original));
});

test('render entrega el texto y lo que falta, sin recortar ni evaluar código', () => {
  const { file } = profile();
  const store = stubStore(file);
  const prompts = new PromptStore({ store, now: () => 1, id: () => 'p-render01' });
  prompts.save({ title: 'Revisión', text: 'Revisá esto:\n{{seleccion}}\nCon foco en {{sitio}}.' });
  const result = prompts.render('p-render01', { seleccion: 'const x = 1;', sitio: 'docs.test', __proto__: 'x' });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Revisá esto:\nconst x = 1;\nCon foco en docs.test.');
  assert.deepEqual(result.missing, []);
  const missing = prompts.render('p-render01', { sitio: 'docs.test' });
  assert.match(missing.text, /\{\{seleccion\}\}/);
  assert.deepEqual(missing.missing, ['seleccion']);
  // Nunca se interpreta: los marcadores de plantilla quedan como texto.
  prompts.save({ title: 'Código', text: '<script>alert(1)</script> ${x} `y`' });
  const literal = prompts.render(prompts.list.at(-1).id, {});
  assert.equal(literal.text, '<script>alert(1)</script> ${x} `y`');
  assert.equal(prompts.render('id-invalido', {}).ok, false);
});

/* ------------------------------ IPC ------------------------------ */

test('el IPC de atajos exige la shell propietaria y no acepta remitentes ajenos', () => {
  const save = journal.ipcHandlers.get('nexo:prompts:save');
  const list = journal.ipcHandlers.get('nexo:prompts:list');
  assert.ok(save && list);
  const intruder = { sender: { id: 99, getURL: () => 'https://chatgpt.com/', mainFrame: {}, senderFrame: {} } };
  assert.equal(list(intruder).ok, false);
  assert.equal(save(intruder, { title: 'x', text: 'y' }).ok, false);
  assert.equal(journal.ipcHandlers.get('nexo:prompts:remove')(intruder, 'p-aaaaaa11').ok, false);
  assert.equal(journal.ipcHandlers.get('nexo:prompts:render')(intruder, { id: 'p-aaaaaa11' }).ok, false);
});

test('el preload de la página no expone el canal de atajos ni el de inserción', () => {
  const bridge = read('src/preload/bridge.cjs');
  assert.doesNotMatch(bridge, /nexo:prompts:/);
  assert.doesNotMatch(bridge, /insert-text/);
  // Sólo la shell los declara.
  assert.match(read('src/preload/shell.cjs'), /nexo:prompts:save/);
  // La inserción existe como acción del proceso principal, validada.
  const advanced = read('src/main/advancedBrowser.js');
  assert.match(advanced, /case 'insert-text'/);
  assert.match(advanced, /contents\.insertText\(text\)/);
});

test('insertar un atajo nunca envía el mensaje', () => {
  const source = read('src/ui/shell/app.js') + read('src/ui/shell/promptLibrary.js') + read('src/main/advancedBrowser.js');
  assert.doesNotMatch(source, /insertText[\s\S]{0,400}submit/i);
  assert.doesNotMatch(source, /insertText[\s\S]{0,400}\.click\(\)/);
  const library = read('src/ui/shell/promptLibrary.js');
  assert.match(library, /No se envió/);
  // Sin dependencias de red para guardar o insertar.
  assert.doesNotMatch(library, /fetch\(|XMLHttpRequest/);
});

test('los atajos de conversación están en menú, panel y atajo de teclado, sin duplicar', () => {
  const html = read('src/ui/shell/index.html');
  assert.match(html, /id="panel-tab-prompts"[^>]*aria-controls="panel-prompts"/);
  assert.match(html, /id="panel-prompts"[^>]*aria-labelledby="panel-tab-prompts"/);
  assert.match(html, /id="promptRoot"/);
  const menu = read('src/main/menu.js');
  assert.match(menu, /run\('prompt-list'\)/);
  assert.match(menu, /run\('prompt-bar'\)/);
  const shortcuts = read('src/nav/shortcuts.js');
  assert.match(shortcuts, /\['prompt-list', 'Atajos de conversación', 'Ctrl\+Shift\+P'\]/);
  const hub = read('src/ui/shell/navigationHub.js');
  assert.match(hub, /'prompt-list', 'Atajos de conversación'/);
  assert.match(hub, /'prompt-bar', 'Insertar un atajo'/);
});

test('la selección se pide a la pestaña real, no a la shell vacía', () => {
  const app = read('src/ui/shell/app.js');
  assert.match(app, /selectedText:async\(\)=>\{[\s\S]{0,200}action:\s*'selected-text'/);
  const advanced = read('src/main/advancedBrowser.js');
  assert.match(advanced, /case 'selected-text'/);
  // Lee contenido real y lo acota; no lo envía a ningún lado.
  const bloque = advanced.slice(advanced.indexOf("case 'selected-text'"));
  assert.match(bloque.slice(0, 900), /executeJavaScript/);
  assert.match(bloque.slice(0, 900), /slice\(0, 20000\)/);
  assert.doesNotMatch(bloque.slice(0, 900), /fetch\(|http[s]?:\/\//);
  const library = read('src/ui/shell/promptLibrary.js');
  assert.match(library, /async function values\(\)/);
  assert.match(library, /await values\(\)/);
});
