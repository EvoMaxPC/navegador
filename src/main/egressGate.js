// Lógica del canal `egress` del proceso principal. Sin Electron: todo lo que
// toca el exterior (config, diálogo, diagnósticos) se inyecta, para poder
// probarla en Node. NUNCA devuelve valores detectados ni el vault.
import { detectSensitive } from '../egress/detect.js';
import { decide } from '../egress/policy.js';
import { createVault } from '../egress/vault.js';
import { redact, summarize } from '../egress/redact.js';
import { normalizeEgress } from '../core/egressConfig.js';

const MAX_SLOTS = 64;
const MAX_CHARS = 1_000_000;
const UNREADABLE_REASONS = ['formulario', 'stream-o-desconocido', 'sin-cuerpo', 'demasiado-grande', 'sin-texto'];

export function createEgressGate({ getConfig, askUser, onDiagnostic = () => {}, onStats = () => {} }) {
  const stats = { clean: 0, observed: 0, blocked: 0, replaced: 0, sentAnyway: 0, unreadable: 0, errors: 0, unauthorized: 0 };
  const vaults = new WeakMap();
  const busy = new Set();
  const bump = (k) => { stats[k] += 1; };

  const vaultOf = (sender) => {
    let v = vaults.get(sender);
    if (!v) { v = createVault(); vaults.set(sender, v); }
    return v;
  };

  const describe = (summary) => summary.map((s) => `${s.type}×${s.count}`).join(', ');

  const block = (reason, summary) => {
    bump('blocked');
    onDiagnostic({ code: 'egress-block', severity: 'info', title: 'NEXO retuvo un envío con datos sensibles',
      detail: `Tipos: ${describe(summary)}. Motivo: ${reason}.` });
    onStats();
    return { action: 'block', reason };
  };

  async function handle({ sender, host, payload }) {
    const cfg = normalizeEgress(getConfig(host));
    if (cfg.mode === 'off') return { action: 'pass', mode: 'off' };

    // Cuerpo ilegible: lo declara el llamador con un motivo conocido.
    if (typeof payload?.unreadable === 'string') {
      const reason = UNREADABLE_REASONS.includes(payload.unreadable) ? payload.unreadable : 'otro';
      bump('unreadable');
      onDiagnostic({ code: 'egress-unreadable', severity: 'info', title: 'NEXO no pudo leer el cuerpo del envío',
        detail: `Motivo: ${reason}. Modo: ${cfg.mode}.` });
      onStats();
      return { action: cfg.mode === 'enforce' && cfg.onUnreadable === 'block' ? 'block' : 'pass', reason };
    }

    const slots = payload?.slots;
    if (!Array.isArray(slots) || slots.length === 0 || slots.length > MAX_SLOTS ||
        slots.some((s) => typeof s !== 'string') ||
        slots.reduce((n, s) => n + s.length, 0) > MAX_CHARS) {
      bump('errors');
      return { action: 'error', reason: 'payload' };
    }

    const per = slots.map((s) => detectSensitive(s));
    const all = per.flat();
    if (!all.length) { bump('clean'); return { action: 'pass' }; }

    const decision = decide(all, cfg);
    if (cfg.mode === 'observe' || decision.action === 'pass') {
      bump('observed');
      return { action: 'pass' };
    }

    // enforce + hallazgo crítico: NO debe haber ningún await antes de busy.add.
    const id = sender?.id;
    if (busy.has(id)) return block('busy', summarize(all));
    busy.add(id);
    try {
      const canRewrite = payload.canRewrite === true;
      const allowed = canRewrite ? decision.allowed : decision.allowed.filter((a) => a !== 'redact');
      const summary = summarize(all);
      let choice;
      try {
        choice = await askUser({ sender, summary, allowed, timeoutMs: cfg.decisionTimeoutMs });
      } catch {
        bump('errors');
        return { action: 'error', reason: 'dialogo' };
      }
      // `allowed` es lo que se OFRECE, no lo que se acepta: 'cancel' está en la
      // lista y aun así debe bloquear, no caer en redactar. Solo 'redact' y
      // 'send' continúan, y 'send' además exige estar ofrecido.
      if ((choice !== 'redact' && choice !== 'send') || !allowed.includes(choice)) {
        return block(choice === 'timeout' ? 'timeout' : 'cancelado', summary);
      }
      if (choice === 'send') {
        bump('sentAnyway');
        onDiagnostic({ code: 'egress-send-anyway', severity: 'warn', title: 'El usuario envió datos sensibles',
          detail: `Tipos: ${describe(summary)}.` });
        onStats();
        return { action: 'pass' };
      }
      const vault = vaultOf(sender);
      const out = slots.map((s, i) => redact(s, per[i], vault, { only: decision.redactTypes }));
      if (out.some((s) => detectSensitive(s).some((f) => f.severity === 'critical'))) {
        return block('redaccion-incompleta', summary);
      }
      bump('replaced');
      onDiagnostic({ code: 'egress-redact', severity: 'info', title: 'NEXO redactó datos sensibles antes de enviar',
        detail: `Tipos: ${describe(summary)}.` });
      onStats();
      return { action: 'replace', slots: out };
    } finally {
      busy.delete(id);
    }
  }

  return {
    handle,
    noteUnauthorized() { bump('unauthorized'); },
    stats: () => ({ ...stats }),
  };
}
