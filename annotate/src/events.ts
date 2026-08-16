import type { AnnotatorEvents, EventHandler, EventName } from "./types";

export class Emitter {
  private handlers = new Map<EventName, Set<EventHandler<any>>>();

  on<E extends EventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  emit<E extends EventName>(event: E, payload: AnnotatorEvents[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // A broken listener must not break the annotator or other listeners.
        console.error(`[webmods-annotate] "${event}" handler threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export function generateId(): string {
  // ULID-style: sortable timestamp prefix + random suffix; unique enough for merge/export.
  const time = Date.now().toString(36).padStart(9, "0");
  let rand = "";
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    rand = Array.from(bytes, (b) => (b % 36).toString(36)).join("");
  } else {
    while (rand.length < 10) rand += Math.random().toString(36).slice(2);
    rand = rand.slice(0, 10);
  }
  return `${time}${rand}`;
}
