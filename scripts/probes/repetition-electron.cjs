/** Integración real: app + shell + webview HTTPS local + preload + IPC. Sin cuenta ni red ChatGPT. */
const { app, BrowserWindow, session, ipcMain, webContents } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const out = process.env.NEXO_REPETITION_OUT || resolve('ci-repetition.json');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'nexo-repetition-')));
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
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => realHandle(channel, async (event, payload) => {
  const result = await listener(event, payload);
  if (channel === 'nexo:repetition:snapshot') report.snapshots.push({ turns: payload?.turns?.length, accepted: result?.ok,
    senderType: event.sender.getType(), mainFrame: event.senderFrame === event.sender.mainFrame, matchingUrl: payload?.href === event.sender.getURL() });
  return result;
});

// Intercepta HTTPS en esta sesión aislada. No relaja TLS ni modifica producción.
app.whenReady().then(() => {
  session.fromPartition('persist:nexo').protocol.handle('https', request => {
    if (new URL(request.url).hostname !== 'chatgpt.com') return new Response('', { status: 404 });
    return new Response('<!doctype html><meta charset="utf-8"><title>Fixture ChatGPT</title><main><article data-turn="user" data-turn-id="u"><div data-message-author-role="user"><pre class="whitespace-pre-wrap">  Hola\n</pre></div></article><article data-turn="assistant" data-turn-id="a"><div data-message-author-role="assistant"><pre class="markdown">Respuesta de fixture 😊\n  código\n</pre></div></article></main>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
});
(async () => {
  await import(pathToFileURL(resolve(__dirname, '../../src/main/main.js')).href);
  await app.whenReady();
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().startsWith('nexo://app/')), 'shell creada');
  const shell = BrowserWindow.getAllWindows()[0].webContents;
  await until(() => shell.executeJavaScript('Boolean(window.nexo && document.querySelector("webview"))').catch(() => false), 'shell lista');
  await shell.executeJavaScript(`(async()=>{await nexo.setSettings({enabled:false,memory:{enabled:false}});document.getElementById('omnibox').value='https://chatgpt.com/c/fixture';document.getElementById('omniboxForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.querySelector('.stab[data-panel="repetition"]').click();})()`);
  await until(() => webContents.getAllWebContents().some(w => w.getType() === 'webview' && w.getURL() === 'https://chatgpt.com/c/fixture'), 'webview HTTPS cargada');
  const guest = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL() === 'https://chatgpt.com/c/fixture');
  try {
    await until(() => shell.executeJavaScript('document.querySelectorAll(".repeat-message").length===2'), 'dos roles recibidos en panel real');
    const exact = await shell.executeJavaScript(String.raw`(()=>{const t=[...document.querySelectorAll('.repeat-text')].map(n=>n.textContent);return t[0]==='  Hola\n'&&t[1]==='Respuesta de fixture 😊\n  código\n';})()`);
    if (!exact) throw Error('Texto no literal en el panel');
    report.checks.push('texto literal y memoria apagada');
    await guest.executeJavaScript(`document.querySelector('.markdown').textContent+='Respuesta final';`);
    await until(() => shell.executeJavaScript('document.querySelectorAll(".repeat-text")[1]?.textContent.endsWith("Respuesta final")'), 'streaming DOM actualiza panel sin duplicados');
    finish();
  } catch (error) {
    report.reader = await guest.executeJavaScript('window.__nexo?.conversationReader?.()').catch(() => null);
    report.panel = await shell.executeJavaScript('document.getElementById("repetitionDiagnostic")?.textContent').catch(() => null);
    throw error;
  }
})().catch(finish);
