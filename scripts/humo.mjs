/**
 * Lanza el ejecutable empaquetado en modo humo y decide si pasó.
 *
 * `nexo.exe --smoke` abre la ventana real, se autodiagnostica y deja el informe
 * en el archivo que indica NEXO_SMOKE_OUT. Esta pieza es la que lo corre desde
 * la línea de comandos (o desde el flujo de Windows) y traduce el resultado a un
 * código de salida.
 *
 * Se hace en Node y no en PowerShell a propósito: el código de salida de un
 * binario de interfaz gráfica y el manejo de errores de los comandos nativos
 * cambian entre versiones del intérprete, y eso ya rompió el flujo dos veces.
 *
 *   node scripts/humo.mjs
 *   node scripts/humo.mjs --exe=dist/Nexo-win32-x64/nexo.exe --out=ci-humo.txt
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Texto que deja el ejecutable cuando todas las comprobaciones pasan. */
export const EXITO = 'arrancó y funciona';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

/**
 * Corre el ejecutable y arma el informe del flujo.
 *
 * @param {{
 *   exe: string,
 *   args?: string[],
 *   out: string,
 *   timeout?: number,
 *   spawn?: typeof spawnSync,
 *   env?: Record<string, string>
 * }} options
 * @returns {{ ok: boolean, code: number|null, report: string, texto: string, motivo?: string }}
 */
export function verifySmoke(options) {
  const { exe, args = ['--smoke'], out, timeout = 120_000, spawn = spawnSync, env = {} } = options;

  if (!existsSync(exe)) {
    const motivo = `no existe el ejecutable: ${exe}`;
    return { ok: false, code: null, report: '', texto: `${motivo}\n`, motivo };
  }

  const started = Date.now();
  const child = spawn(exe, args, {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, NEXO_SMOKE_OUT: out, ELECTRON_ENABLE_LOGGING: '1', ...env },
  });
  const segundos = ((Date.now() - started) / 1000).toFixed(1);

  // El informe lo escribe la aplicación; la salida del proceso es un extra.
  let report = '';
  if (existsSync(out)) {
    try {
      report = readFileSync(out, 'utf8');
    } catch (error) {
      report = `no se pudo leer el informe: ${error.message}\n`;
    }
  }

  const partes = [];
  if (report) partes.push(report.trimEnd());
  else partes.push('sin informe: el ejecutable no llegó a escribirlo');
  partes.push(`código de salida: ${child.status === null ? 'señal ' + child.signal : child.status}`);
  partes.push(`duración: ${segundos} s`);
  const salida = `${child.stdout || ''}${child.stderr || ''}`.trim();
  if (salida) {
    partes.push('===== salida del ejecutable =====');
    partes.push(salida.length > 8000 ? `${salida.slice(0, 8000)}\n…` : salida);
  }
  const texto = `${partes.join('\n')}\n`;

  const paso = report.includes(EXITO);
  const motivo = paso ? undefined : report ? 'el informe no dice que arrancó y funciona' : 'sin informe';
  return { ok: paso, code: child.status, report, texto, motivo };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const exe = resolve(root, arg('exe', 'dist/Nexo-win32-x64/nexo.exe'));
  const out = resolve(root, arg('out', 'ci-humo.txt'));

  const result = verifySmoke({ exe, out });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.texto, 'utf8');
  process.stdout.write(result.texto);

  if (result.ok) {
    console.log('\n✔ el ejecutable empaquetado arranca y funciona\n');
  } else {
    console.error(`\n✖ la prueba de humo falló: ${result.motivo}\n`);
    process.exit(1);
  }
}
