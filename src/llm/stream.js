/**
 * My Next Prediction v3.0 — M6 · Ollama NDJSON stream parser
 * ----------------------------------------------------------
 * Pure functions for parsing /api/generate's newline-delimited JSON
 * stream into token chunks.
 *
 *   parseChunk(text, partial) → { tokens, partial }
 *   readStream(response, onToken, onDone, onError) → reads ReadableStream
 *
 * Each NDJSON line is a JSON object:
 *   { model, response, done, ... }   // /api/generate
 *   { message: { content }, done }    // /api/chat
 *
 * "response" / "message.content" carry the streamed token chunk.
 */

/**
 * Parse a buffer of NDJSON.  Carries trailing partial line into the
 * next call.  Returns { events, partial }.
 */
export function parseChunk(text, partial = "") {
  const buf = (partial || "") + (text || "");
  const lines = buf.split("\n");
  const partialOut = lines.pop() || "";
  const events = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); }
    catch { /* malformed line — drop */ }
  }
  return { events, partial: partialOut };
}

/**
 * Pull the streamed token text out of an Ollama event.  Handles both
 * /api/generate (`response`) and /api/chat (`message.content`) shapes.
 */
export function tokenOf(ev) {
  if (!ev) return "";
  if (typeof ev.response === "string") return ev.response;
  if (ev.message && typeof ev.message.content === "string") return ev.message.content;
  return "";
}

/**
 * Read a fetch Response body as Ollama NDJSON stream.  Calls
 * `onToken(text, ev)` per token, `onDone(finalEv)` on end-of-stream,
 * `onError(err)` on parse / network failure.
 *
 * @param {Response} response
 * @returns {Promise<{aborted:boolean, finalEvent:object|null, fullText:string}>}
 */
export async function readStream(response, { onToken, onDone, onError, signal } = {}) {
  if (!response?.body || !response.body.getReader) {
    throw new Error("readStream: response.body missing");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let partial = "";
  let fullText = "";
  let finalEvent = null;
  let aborted = false;

  const onAbort = () => { aborted = true; try { reader.cancel(); } catch {} };
  signal?.addEventListener?.("abort", onAbort, { once: true });

  try {
    while (true) {
      if (aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const { events, partial: p } = parseChunk(chunk, partial);
      partial = p;
      for (const ev of events) {
        const tok = tokenOf(ev);
        if (tok) {
          fullText += tok;
          try { onToken?.(tok, ev); } catch {}
        }
        if (ev.done) {
          finalEvent = ev;
          try { onDone?.(ev); } catch {}
        }
      }
    }
    // Flush trailing line
    const tail = partial.trim();
    if (tail) {
      try {
        const ev = JSON.parse(tail);
        const tok = tokenOf(ev);
        if (tok) {
          fullText += tok;
          try { onToken?.(tok, ev); } catch {}
        }
        if (ev.done) {
          finalEvent = ev;
          try { onDone?.(ev); } catch {}
        }
      } catch { /* malformed tail */ }
    }
  } catch (err) {
    try { onError?.(err); } catch {}
    throw err;
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
  }

  return { aborted, finalEvent, fullText };
}
