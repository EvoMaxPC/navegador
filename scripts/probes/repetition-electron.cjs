/** Integración real: app + shell + webview HTTPS local + preload + IPC. Sin cuenta ni red ChatGPT. */
const { app, BrowserWindow, session, ipcMain, webContents } = require('electron');
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const out = process.env.NEXO_REPETITION_OUT || resolve('ci-repetition.json');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'nexo-repetition-')));
app.setPath('documents', app.getPath('userData'));
app.disableHardwareAcceleration();
process.env.NEXO_NETWATCH = '0';
process.env.NEXO_CDP = '0';
const report = { ok: false, checks: [], snapshots: [] };
const timeout = setTimeout(() => finish(Error('Timeout de integración Electron')), 60000);
function finish(error) {
  clearTimeout(timeout);
  if (error) report.error = String(error.stack || error);
  else report.ok = true;
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  app.exit(error ? 1 : 0);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { if (await fn()) { report.checks.push(label); return; } await pause(100); }
  throw Error(label);
}
let suppressAutomaticSnapshot = false;
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => realHandle(channel, async (event, payload) => {
  const result = await listener(event, payload);
  if (channel === 'nexo:repetition:snapshot') report.snapshots.push({ turns: payload?.turns?.length, accepted: result?.ok,
    senderType: event.sender.getType(), mainFrame: event.senderFrame === event.sender.mainFrame, matchingUrl: payload?.href === event.sender.getURL() });
  return channel === 'nexo:repetition:get' && suppressAutomaticSnapshot ? null : result;
});

// Intercepta HTTPS en esta sesión aislada. No relaja TLS ni modifica producción.
app.whenReady().then(() => {
  session.fromPartition('persist:nexo').protocol.handle('https', request => {
    if (new URL(request.url).hostname !== 'chatgpt.com') return new Response('', { status: 404 });
    return new Response('<!doctype html><meta charset="utf-8"><title>Fixture ChatGPT</title><main><h4>Dijiste:</h4><div class="group user-message"><div data-message-author-role="user"><pre class="whitespace-pre-wrap">  Hola\n</pre></div></div><h4>ChatGPT dijo:</h4><div class="assistant-message"><div data-message-author-role="assistant"><pre class="markdown">Respuesta de fixture 😊\n  código\n</pre></div></div></main>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
});
(async () => {
  await import(pathToFileURL(resolve(__dirname, '../../src/main/main.js')).href);
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().startsWith('nexo://app/')), 'shell creada');
  const shell = BrowserWindow.getAllWindows()[0].webContents;
  app.getAppMetrics(); // Punto inicial de la muestra CPU; sólo harness de prueba.
  const realSend = shell.send.bind(shell);
  shell.send = (channel, ...args) => { if (channel !== 'nexo:repetition-changed' || !suppressAutomaticSnapshot) realSend(channel, ...args); };
  await until(() => shell.executeJavaScript('Boolean(window.nexo && document.querySelector("webview"))').catch(() => false), 'shell lista');
  await shell.executeJavaScript(`(async()=>{await nexo.setSettings({enabled:false,memory:{enabled:false}});await nexo.advanced.setPreferences({...await nexo.advanced.preferences(),rightMenuMode:'fixed'});document.getElementById('omnibox').value='https://chatgpt.com/c/fixture';document.getElementById('omniboxForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.querySelector('.rail-item[data-open-panel="memory"]').click();})()`);
  await until(() => webContents.getAllWebContents().some(w => w.getType() === 'webview' && w.getURL() === 'https://chatgpt.com/c/fixture'), 'webview HTTPS cargada');
  const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL() === 'https://chatgpt.com/c/fixture');
  try {
    // EVO apagada no muestra recuerdos. El lector aislado conserva su canal
    // RAM independiente: comprobarlo por IPC, no resucitando la pestaña retirada.
    const readSnapshot = () => shell.executeJavaScript(`nexo.repetition.get(${JSON.stringify({ webContentsId: guest.id, href: guest.getURL() })})`);
    await until(async () => (await readSnapshot())?.turns?.length === 2, 'lector aislado entrega ambos roles con EVO apagada');
    const initial = await readSnapshot();
    const expected = ['  Hola\n', 'Respuesta de fixture 😊\n  código\n'];
    if (JSON.stringify(initial.turns.map(t => t.content)) !== JSON.stringify(expected)) throw Error('Texto no literal en el snapshot aislado');
    if (!initial.strategy.includes('print-label') || initial.turns[0].role !== 'user' || initial.turns[1].role !== 'assistant') {
      throw Error('El lector no confirma una pregunta y una respuesta sin duplicados');
    }
    await until(() => shell.executeJavaScript(`document.getElementById('memoryPersistence').dataset.state==='disabled' && document.querySelectorAll('#memoryLiveConversation .repeat-message').length===0`), 'EVO apagada oculta recuerdos sin apagar el lector aislado');
    const disabledConversations = await shell.executeJavaScript('nexo.memory.conversations()');
    if (disabledConversations.length) throw Error('EVO apagada no debe publicar conversaciones guardadas');
    report.checks.push('texto literal y ambos roles por IPC sin persistencia EVO habilitada');
    await guest.executeJavaScript(`document.querySelector('.markdown').textContent+='Respuesta final';`);
    await until(async () => (await readSnapshot())?.turns?.[1]?.content.endsWith('Respuesta final'), 'streaming DOM actualiza lector aislado sin duplicados');
    await shell.executeJavaScript(`(async()=>{await nexo.setSettings({enabled:false,memory:{enabled:true}});document.querySelector('.stab[data-panel="memory"]').click();})()`);
    await until(() => shell.executeJavaScript('document.querySelectorAll("#memoryLiveConversation .repeat-text").length===2'), 'Memoria muestra la misma conversación en vivo');
    await guest.executeJavaScript(`window.postMessage({__nexo:'event',type:'outgoing',payload:{host:'chatgpt.com',site:'chatgpt',source:'composer',messageId:'render-fixture-send',tokenText:'pregunta nueva',chars:14}},'*');const u=document.createElement('article');u.setAttribute('data-message-author-role','user');u.setAttribute('data-message-id','u2');u.textContent='pregunta nueva';document.querySelector('main').append(u);`);
    await until(() => shell.executeJavaScript('document.querySelectorAll("#memoryLiveConversation .repeat-text").length===3'), 'envío observado sin contar historial como salida');
    await guest.executeJavaScript(`const a=document.createElement('article');a.setAttribute('data-message-author-role','assistant');a.setAttribute('data-message-id','a2');a.innerHTML='<pre id="liveAnswer" class="markdown"></pre>';document.querySelector('main').append(a);const stop=document.createElement('button');stop.id='fixtureStop';stop.setAttribute('data-testid','stop-button');document.body.append(stop);`);
    for (const [text, words] of [['  uno',1],['  uno dos',2],['  uno dos tres\n',3]]) {
      await guest.executeJavaScript(`document.getElementById('liveAnswer').textContent=${JSON.stringify(text)}`);
      await until(() => shell.executeJavaScript(`document.querySelectorAll('#memoryLiveConversation .repeat-text')[3]?.textContent===${JSON.stringify(text)}`), `Memoria refleja parcial ${words} palabra(s)`);
      await until(() => shell.executeJavaScript(`nexo.getStats().then(s=>s.outputTokens===${words} && s.responses===0)`), `contador visible suma ${words} palabra(s) antes de terminar`);
    }
    await guest.executeJavaScript(`document.getElementById('fixtureStop').remove()`);
    await until(() => shell.executeJavaScript('nexo.getStats().then(s=>s.responses===1 && s.outputTokens===3)'), 'cierre DOM conserva tres palabras y una respuesta');
    const finalText = '  uno dos tres\n';
    await until(() => shell.executeJavaScript(`nexo.memory.conversations().then(c=>c.some(e=>e.turns.some(t=>t.id==='a2'&&t.content===${JSON.stringify(finalText)})))`), 'transcripción persistente contiene texto literal final');
    const memoryFile = await shell.executeJavaScript('nexo.memory.stats().then(s=>s.file)');
    const disk = JSON.parse(readFileSync(memoryFile, 'utf8'));
    if (!disk.conversations.some(c=>c.turns.some(t=>t.id==='a2' && t.content===finalText))) throw Error('El archivo de memoria no contiene el texto literal');
    report.checks.push('texto literal confirmado también leyendo el archivo de memoria');
    await shell.executeJavaScript(`document.querySelector('.rail-item[data-open-panel="memory"]').click()`);
    // Las APIs del mundo principal no deben controlar el lector aislado.
    await guest.executeJavaScript(`delete window.__nexo; Document.prototype.querySelectorAll=function(){throw Error('API alterada por la página de prueba');};const body=document.createElement('body');body.innerHTML='<article data-turn="assistant"><pre class="markdown">GPT tras reemplazar body</pre></article>';document.body.replaceWith(body);`);
    await until(() => shell.executeJavaScript('document.querySelectorAll("#memoryLiveConversation .repeat-text").length===1 && document.querySelector("#memoryLiveConversation .repeat-text").textContent==="GPT tras reemplazar body"'), 'lector aislado sobrevive APIs de página alteradas y body sustituido');
    await guest.executeJavaScript(`window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));document.getElementsByTagName('pre')[0].textContent='GPT después de pageshow';window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));`);
    await until(() => shell.executeJavaScript('document.querySelector("#memoryLiveConversation .repeat-text")?.textContent==="GPT después de pageshow"'), 'reanuda tras eventos pagehide/pageshow sintéticos');
    // Forzar la rama de respaldo de la shell: sin caché consultable ni eventos
    // automáticos visibles, aunque el DOM HTTPS contiene ambos mensajes.
    suppressAutomaticSnapshot = true;
    await shell.executeJavaScript(`document.getElementById('omnibox').value='https://chatgpt.com/c/direct-fallback-only';document.getElementById('omniboxForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await until(() => guest.getURL() === 'https://chatgpt.com/c/direct-fallback-only' && !guest.isLoading(), 'documento nuevo para respaldo directo');
    await shell.executeJavaScript(`document.querySelector('.stab[data-panel="memory"]').click()`);
    await until(() => shell.executeJavaScript(`document.getElementById('memoryLiveConversation').dataset.strategy==='direct-console-injection' && document.querySelectorAll('#memoryLiveConversation .repeat-text').length===2`), 'respaldo executeJavaScript muestra ambos roles sin snapshot automático');
    const directText = await guest.executeJavaScript(`[...document.querySelectorAll('main h4')].map(h=>h.nextElementSibling.innerText)`);
    const displayed = await shell.executeJavaScript(`[...document.querySelectorAll('#memoryLiveConversation .repeat-text')].map(n=>n.textContent)`);
    if (JSON.stringify(displayed) !== JSON.stringify(directText)) throw Error('El respaldo no conserva innerText literal');
    report.checks.push('texto literal del respaldo comparado contra DOM real del webview');
    const ramNotice = await shell.executeJavaScript(`document.getElementById('memoryPersistence').dataset.state==='ram' && document.getElementById('memoryPersistenceDetail').textContent.includes('no confirma')`);
    if (!ramNotice) throw Error('La interfaz debe distinguir el respaldo RAM de la persistencia');
    suppressAutomaticSnapshot = false;
    // Contrato visual sobre Electron real: sin cambiar ningún motor ni datos de producción.
    const pinned = await shell.executeJavaScript(`(()=>{const viewport=document.getElementById('viewport');const before=viewport.clientWidth;document.getElementById('pinSidebar').click();const floating=viewport.clientWidth;const pressed=document.getElementById('pinSidebar').getAttribute('aria-pressed');document.getElementById('pinSidebar').click();return floating>before && pressed==='false' && viewport.clientWidth===before;})()`);
    if (!pinned) throw Error('Fijar/desfijar no reserva/libera el ancho de página');
    report.checks.push('anclaje real de panel conserva el webview y cambia el espacio reservado');
    writeFileSync(resolve('ci-ui-memory-fixture.png'), (await shell.capturePage()).toPNG());
    await shell.executeJavaScript(`document.getElementById('bookmarkBtn').click()`);
    await until(() => shell.executeJavaScript(`nexo.bookmarks.list({}).then(items=>items.some(item=>item.url==='https://chatgpt.com/c/direct-fallback-only'))`), 'estrella guarda marcador real por IPC');
    await shell.executeJavaScript(`document.querySelector('[data-memory-section="favorites"]').click()`);
    await until(() => shell.executeJavaScript(`!document.getElementById('memory-pane-favorites').hidden && [...document.querySelectorAll('#memoryFavorites .nav-open')].some(item=>item.dataset.url==='https://chatgpt.com/c/direct-fallback-only')`), 'Favoritos muestra el marcador real sin salir del panel EVO');
    await shell.executeJavaScript(`document.querySelector('[data-memory-section="saved"]').click()`);
    await until(() => shell.executeJavaScript(`!document.getElementById('memory-pane-saved').hidden && document.querySelectorAll('#memoryConversations li').length>0`), 'Historial de EVO muestra registro real consultado');
    await shell.executeJavaScript(`document.querySelector('[data-memory-section="conversation"]').click();document.querySelector('.rail-item[data-open-panel="history"]').click()`);
    await until(() => shell.executeJavaScript(`document.querySelectorAll('#historyList .nav-open').length>0`), 'historial del navegador conserva navegación real');
    await until(() => shell.executeJavaScript(`!document.getElementById('back').disabled`), 'atrás disponible después de dos navegaciones');
    await shell.executeJavaScript(`document.getElementById('back').click()`);
    await until(() => guest.getURL()==='https://chatgpt.com/c/fixture' && !guest.isLoading(), 'atrás navega al documento anterior');
    await until(() => shell.executeJavaScript(`!document.getElementById('forward').disabled`), 'adelante disponible');
    await shell.executeJavaScript(`document.getElementById('forward').click()`);
    await until(() => guest.getURL()==='https://chatgpt.com/c/direct-fallback-only' && !guest.isLoading(), 'adelante restaura el documento');
    await shell.executeJavaScript(`document.getElementById('homeButton').click()`);
    await until(() => guest.getURL()==='nexo://app/src/ui/start/index.html' && !guest.isLoading(), 'Inicio abre la página interna real');
    await until(() => guest.executeJavaScript(`[...document.querySelectorAll('.app-icon img')].length===3 && [...document.querySelectorAll('.app-icon img')].every(i=>i.complete && i.naturalWidth>0)`), 'tres iconos de marca cargados por protocolo interno');
    await shell.executeJavaScript(`document.querySelector('.rail-item[data-open-panel="memory"]').click();document.getElementById('newTab').click()`);
    await until(() => shell.executeJavaScript(`document.querySelectorAll('.tab').length===2`), 'botón nueva pestaña crea segundo webview');
    await shell.executeJavaScript(`document.querySelector('.tab.active .close').click()`);
    await until(() => shell.executeJavaScript(`document.querySelectorAll('.tab').length===1`), 'cerrar pestaña conserva la original');
    writeFileSync(resolve('ci-ui-start.png'), (await shell.capturePage()).toPNG());
    report.uiEvidence = 'Electron real; conversaciones de fixture HTTPS local, sin cuenta autenticada';
    report.processMetrics = app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpuPercent: cpu.percentCPUUsage, workingSetKB: memory.workingSetSize, privateKB: memory.privateBytes }));
    report.processMetricsContext = 'Muestra final de integración, aceleración por hardware desactivada; CPU media desde la consulta inicial, no medición de uso cotidiano ni comparación entre versiones';
    finish();
  } catch (error) {
    report.reader = await guest.executeJavaScript('window.__nexo?.conversationReader?.()').catch(() => null);
    report.panel = await shell.executeJavaScript('document.getElementById("memoryLiveStatus")?.textContent').catch(() => null);
    throw error;
  }
})().catch(finish);
