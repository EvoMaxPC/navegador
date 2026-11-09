# Adaptadores por sitio

Cada sitio de IA se describe con un objeto en `src/core/sites.js`:

```js
{
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],   // dominios cubiertos
  composer: ['#prompt-textarea', ...],         // cuadro de texto (continuación)
  sendButton: ['button[data-testid="send-button"]', ...],
  requestMatch: /backend-api\/conversation/,   // petición de chat
  requestPath: ['/backend-api/conversation',   // rutas exactas (sin consulta)
                '/backend-api/f/conversation'],
  postOnly: true,                              // sólo POST
  streamAdapter: 'chatgpt',                    // lector del stream
  body: { kind: 'chatgpt-messages', strict: true }, // forma del cuerpo
  deltaPaths: ['message.content.parts'],       // pistas para leer el stream
  accent: '#10a37f',
}
```

## Qué usa cada capa

| Capa | Necesita | Fragilidad |
|---|---|---|
| Intervención saliente | `requestPath` + `postOnly` + `body.kind` | baja: la URL y el esquema cambian poco |
| Filtro de respuesta | `streamAdapter` (o `deltaPaths` genérico) | baja: el formato SSE es estable |
| Continuación automática | `composer` + `sendButton` | alta: los selectores cambian seguido |

El motor está diseñado para que si un adaptador falla, la consecuencia sea «no se
media ese sitio», nunca «se rompe el sitio».

**Qué cuenta como envío de mensaje.** Se compara la ruta por `pathname` (la
consulta no importa) y el método. En ChatGPT además se exige que el cuerpo sea un
envío real: `action` distinto de `next` o sin mensaje nuevo (regenerar, continuar)
no se reescribe, y nunca se rellena con otro campo del cuerpo. Con `strict: true`
un cuerpo que no encaja deja de mediarse en vez de adivinar.

## Estado

| Sitio | Host | Petición | Stream | Continuación | Notas |
|---|---|---|---|---|---|
| ChatGPT | `chatgpt.com` | `messages[].content.parts` | `v` / `message.content.parts` | selectores actuales | el cuerpo usa roles anidados (`author.role`) |
| Claude | `claude.ai` | `prompt` | `completion` / `delta.text` | botón «Send message» | respuesta en SSE con `content_block_delta` |
| Gemini | `gemini.google.com` | `f_req` (JSON anidado en string) | heurística | selectores actuales | el mensaje vive en un string JSON dentro de otro |
| Copilot | `copilot.microsoft.com` | `messages[]` | heurística | selectores actuales | a veces usa WebSocket: no se filtra |
| Perplexity | `perplexity.ai` | busca último string de contenido | `text` / `delta` | selectores actuales | |
| DeepSeek | `chat.deepseek.com` | `messages[]` | `v` | selectores actuales | |
| Grok | `grok.com` | GraphQL (`messages[]`) | `response` / `token` | selectores actuales | requiere mantener las variables de la query |
| Le Chat | `chat.mistral.ai` | `messages[]` | `content` / `delta` | selectores actuales | |
| Ollama / LM Studio | `localhost` | `messages[]` (OpenAI) | `message.content` | selectores actuales | útil para probar con modelos locales |

Estados posibles: **verificado** (probado con la interfaz real), **heurístico**
(funciona por la vía genérica) y **sin verificar**. Hoy la tabla resume la
intención del adaptador; el proyecto no incluye un arnés automático contra los
sitios reales porque requiere sesiones autenticadas.

## Añadir un sitio

1. Copiá un objeto de `SITES` y ajustá `hosts`, `requestMatch` y `body.kind`.
2. Abrí el sitio, escribí un mensaje y mirá la pestaña Red: copiá el `POST` que
   lleva tu texto.
3. Decidí el esquema:
   - `messages[]` con `{role, content}` → `openai-messages`
   - roles anidados (`author.role`) → `chatgpt-messages`
   - campo plano `prompt` → `claude-prompt`
   - otra forma → dejá `generic`: `locateUserText` buscará el último string largo.
4. Si el stream no trae `content`/`text`/`delta` como claves conocidas, agregá
   `deltaPaths` con la ruta exacta (admite `a.b[0].c`).
5. Añadí selectores de `composer` y `sendButton` solo si querés continuación
   automática.

## Probar un adaptador sin el sitio

```js
import { locateUserText, patchUserText, detectSite } from '../src/core/sites.js';

const site = detectSite('chatgpt.com');
const body = JSON.parse('...');        // copiado de la pestaña Red
const found = locateUserText(body, site);
console.log(found?.value);             // tu mensaje
patchUserText(body, site, 'texto mediado');
```

## Limitaciones conocidas

- **WebSockets:** el filtro solo cubre `fetch` con SSE. Un sitio que transmita por
  WebSocket no se puede interceptar por esta vía (se necesitaría enganchar el
  constructor con un proxy bidireccional).
- **Cuerpos binarios o `FormData`:** se dejan pasar sin tocar.
- **Respuestas JSON completas** (sin streaming): se dejan pasar; el motor solo
  analiza, no reescribe (ver `docs/ARQUITECTURA.md`, extensiones previstas).
- **Firmas del cliente:** si un sitio firma el cuerpo de la petición, reescribirlo
  invalida la firma. En ese caso hay que desactivar la mediación en ese sitio
  (*Ajustes → Sitios*).
