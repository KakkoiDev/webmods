// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotator } from "../src/annotator";
import { createAnchor } from "../src/anchors";
import { FIRSTMATE_SENDS_SETTING, createFirstmatePlugin, firstmateFilename, type FirstmatePlugin } from "../src/plugins/firstmate";
import type { FeedResponse, FirstmateStatus, Timers } from "../src/plugins/firstmate-feed";
import { createMemoryStorage } from "../src/storage";
import { DEFAULT_ROOT, folderFor } from "../src/url-folder";
import type { AnnotationStorage, Annotator } from "../src/types";

const T0 = Date.UTC(2026, 8, 28, 3, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const annotators: Annotator[] = [];

afterEach(() => {
  for (const a of annotators.splice(0)) a.destroy();
  document.body.innerHTML = "";
});

const shadow = () => document.querySelector("[data-wm-annotate-ui]")!.shadowRoot!;
const statusText = () => shadow().querySelector(".wm-fm-status .wm-fm-text")?.textContent ?? "";
const statusEl = () => shadow().querySelector<HTMLElement>(".wm-fm-status")!;
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Fake clock for the plugin: `advance` fires due timers in order, letting promises settle between them. */
function fakeClock(start: number) {
  let now = start;
  let id = 0;
  const pending: Array<{ run: () => void; due: number; id: number }> = [];
  const timers: Timers = {
    set: (run, ms) => (pending.push({ run, due: now + ms, id: ++id }), id),
    clear: (handle) => {
      const at = pending.findIndex((t) => t.id === handle);
      if (at >= 0) pending.splice(at, 1);
    },
  };
  return {
    timers,
    pending: () => pending.length,
    now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await settle();
        pending.sort((a, b) => a.due - b.due);
        const next = pending[0];
        if (!next || next.due > end) break;
        pending.shift();
        now = Math.max(now, next.due);
        next.run();
      }
      now = end;
      await settle();
    },
  };
}

/** The watcher's long-poll feed: answers at once on a new version, else holds until `publish` or `down`. */
function fakeServer() {
  let statuses: FirstmateStatus[] = [];
  let version = 1;
  let down = false;
  const urls: string[] = [];
  const held: Array<{ resolve: (r: FeedResponse) => void; reject: (e: Error) => void; folder: string }> = [];
  const answer = (folder: string): FeedResponse => ({
    status: 200,
    text: JSON.stringify({ format: "wm-annotate-firstmate-feed", schemaVersion: 1, folder, version: `v${version}`, now: iso(T0), statuses }),
  });
  return {
    urls,
    held: () => held.length,
    request(url: string): Promise<FeedResponse> {
      urls.push(url);
      if (down) return Promise.reject(new Error("ECONNREFUSED"));
      const params = new URL(url).searchParams;
      const folder = params.get("folder")!;
      if (params.get("since") !== `v${version}`) return Promise.resolve(answer(folder));
      return new Promise((resolve, reject) => held.push({ resolve, reject, folder }));
    },
    publish(next: FirstmateStatus[]) {
      statuses = next;
      version++;
      for (const h of held.splice(0)) h.resolve(answer(h.folder));
    },
    setDown(value: boolean) {
      down = value;
      if (value) for (const h of held.splice(0)) h.reject(new Error("ECONNRESET"));
    },
  };
}

function mount(storage: AnnotationStorage, server: ReturnType<typeof fakeServer>, clock: ReturnType<typeof fakeClock>) {
  const saved: Array<{ path: string; text: string }> = [];
  const notices: string[] = [];
  const annotator = createAnnotator({ storage });
  const plugin: FirstmatePlugin = createFirstmatePlugin({
    save: async (path, text) => void saved.push({ path, text }),
    notify: (m) => notices.push(m),
    now: clock.now,
    timers: clock.timers,
    request: (url) => server.request(url),
    liveReload: false,
  });
  annotator.use(plugin);
  annotators.push(annotator);
  return { annotator, plugin, saved, notices };
}

async function seedNote(annotator: Annotator, text = "tighten this paragraph"): Promise<string> {
  document.body.innerHTML = `<p id="t">The plan says we ship on Friday after review.</p>`;
  return (await annotator.createNote(createAnchor(document.getElementById("t")!, location.href), text)).id;
}

const received = (over: Partial<FirstmateStatus> = {}): FirstmateStatus => ({
  requestId: "r1",
  state: "received",
  at: iso(T0 + 200),
  source: firstmateFilename(T0),
  sentAt: iso(T0),
  noteIds: [],
  inboxId: "fm-abc",
  message: "Delivered to firstmate as inbox note fm-abc",
  ...over,
});

describe("firstmate send indicator", () => {
  it("walks sent, no receipt, received, working and done without an alert, and keeps the state across a reload", async () => {
    const storage = createMemoryStorage();
    const server = fakeServer();
    const clock = fakeClock(T0);
    const first = mount(storage, server, clock);
    const noteId = await seedNote(first.annotator);

    first.annotator.commands.execute("firstmate.send");
    await clock.advance(0);
    expect(first.saved).toHaveLength(2);
    expect(first.notices).toEqual([]);
    expect(statusText()).toBe("Firstmate: Sent, waiting for the watcher");
    expect(statusEl().dataset.quiet).toBe("false");
    // Shown in the floating pill while the sidebar is closed.
    expect(statusEl().parentElement!.classList.contains("wm-status-float")).toBe(true);

    await clock.advance(10_100);
    expect(statusText()).toBe("Firstmate: No receipt after 10 s. Is the watcher running?");

    server.publish([received({ noteIds: [noteId] })]);
    await clock.advance(0);
    expect(statusText()).toBe("Firstmate: Received, waiting for an agent (1 note)");
    expect(statusEl().title).toContain("inbox note fm-abc");

    server.publish([received({ noteIds: [noteId], state: "assigned", at: iso(clock.now()), message: "crewmate on it" })]);
    await clock.advance(0);
    expect(statusText()).toBe("Firstmate: Being worked on: crewmate on it (1 note)");

    // A reload: a fresh annotator on the same storage picks the send back up from the feed.
    first.annotator.destroy();
    const second = mount(storage, server, clock);
    await clock.advance(0);
    expect(statusText()).toBe("Firstmate: Being worked on: crewmate on it (1 note)");

    await clock.advance(10 * 60_000 + 1000);
    expect(statusText()).toBe("Firstmate: No update for over 10 min: crewmate on it (1 note)");

    server.publish([received({ noteIds: [noteId], state: "done", at: iso(clock.now()), message: "tightened" })]);
    await clock.advance(0);
    expect(statusText()).toBe("Firstmate: Done: tightened (1 note)");
    expect(statusEl().dataset.quiet).toBe("false");
    await clock.advance(11_000);
    expect(statusEl().dataset.quiet).toBe("true");
    expect(second.notices).toEqual([]);
  });

  it("shows offline, then reconnects by itself when the watcher comes back", async () => {
    const storage = createMemoryStorage();
    const server = fakeServer();
    const clock = fakeClock(T0);
    server.setDown(true);
    const folder = folderFor(location.href, [DEFAULT_ROOT]);
    await storage.setSetting?.(FIRSTMATE_SENDS_SETTING, { [folder]: { source: firstmateFilename(T0), sentAt: T0, noteIds: ["x"] } });
    server.publish([received({ noteIds: ["x"], state: "done", message: "finished" })]);
    mount(storage, server, clock);

    await clock.advance(0);
    expect(shadow().querySelector(".wm-fm-dot")!.getAttribute("data-on")).toBe("false");
    expect(statusEl().title).toContain("reconnecting");

    await clock.advance(3000);
    const tries = server.urls.length;
    expect(tries).toBeGreaterThanOrEqual(3);
    server.setDown(false);
    await clock.advance(5000);
    expect(shadow().querySelector(".wm-fm-dot")!.getAttribute("data-on")).toBe("true");
    expect(statusText()).toBe("Firstmate: Done: finished (1 note)");
    const url = new URL(server.urls[server.urls.length - 1]);
    expect(url.origin + url.pathname).toBe("http://127.0.0.1:4817/status");
    expect(url.searchParams.get("folder")).toBe(folder);
    expect(url.searchParams.get("client")).toMatch(/^[a-z0-9]+$/);

    // A second outage mid-poll is noticed at once.
    server.setDown(true);
    await clock.advance(0);
    expect(shadow().querySelector(".wm-fm-dot")!.getAttribute("data-on")).toBe("false");

    // A restarted watcher holds a poll that carries the last version for 25 s;
    // the first poll after an outage carries none, so it is answered at once.
    server.setDown(false);
    await clock.advance(5000);
    expect(shadow().querySelector(".wm-fm-dot")!.getAttribute("data-on")).toBe("true");
  });

  it("keeps one poll loop for a send made straight after load, and stops every timer on destroy", async () => {
    const storage = createMemoryStorage();
    const server = fakeServer();
    const clock = fakeClock(T0);
    const folder = folderFor(location.href, [DEFAULT_ROOT]);
    await storage.setSetting?.(FIRSTMATE_SENDS_SETTING, { [folder]: { source: "old.json", sentAt: T0 - 60_000, noteIds: [] } });
    const seeded = mount(storage, server, clock);
    await seedNote(seeded.annotator);
    seeded.annotator.destroy();
    await clock.advance(0);
    const heldBefore = server.held();

    const { annotator, plugin } = mount(storage, server, clock);
    await plugin.send();
    await clock.advance(0);
    expect(server.held() - heldBefore).toBe(1);

    annotator.destroy();
    await clock.advance(20_000);
    expect(clock.pending()).toBe(0);
  });

  it("stays off the network on a web page that never sent", async () => {
    const server = fakeServer();
    const clock = fakeClock(T0);
    mount(createMemoryStorage(), server, clock);
    await clock.advance(1000);
    expect(server.urls).toEqual([]);
    expect(statusEl().dataset.empty).toBe("true");
  });
});

describe("firstmate note threads", () => {
  it("renders firstmate's reply with a one-click doc link, marks the note done, and sends the captain's reply", async () => {
    const storage = createMemoryStorage();
    const server = fakeServer();
    const clock = fakeClock(T0);
    const { annotator, saved } = mount(storage, server, clock);
    const noteId = await seedNote(annotator);
    annotator.openSidebar();
    const section = () => shadow().querySelector<HTMLElement>(`.wm-note[data-note-id="${noteId}"] .wm-note-section[data-section-id="firstmate"]`)!;
    expect(section().childElementCount).toBe(0);

    annotator.commands.execute("firstmate.send");
    await clock.advance(0);
    expect(section().querySelector(".wm-fm-note-state")!.textContent).toBe("Sent, waiting for the watcher");
    expect(section().querySelector("textarea")).not.toBeNull();
    // The docked status row sits in the open sidebar's header.
    expect(statusEl().parentElement!.classList.contains("wm-status-docked")).toBe(true);

    server.publish([
      received({
        noteIds: [noteId],
        state: "assigned",
        at: iso(T0 + 1000),
        replies: [
          {
            noteId,
            author: "firstmate",
            at: iso(T0 + 4000),
            text: "Tightened it. **See** the doc.",
            link: "/Users/me/Downloads/firstmate-annotate/docs/plan.html",
            done: true,
          },
        ],
      }),
    ]);
    await clock.advance(0);
    expect(section().querySelector(".wm-fm-note-state")!.textContent).toBe("Done");
    const reply = section().querySelector(".wm-fm-reply")!;
    expect(reply.querySelector(".wm-fm-reply-head")!.textContent).toMatch(/^firstmate · .* · done$/);
    expect(reply.querySelector("strong")!.textContent).toBe("See");
    const link = reply.querySelector<HTMLAnchorElement>("a.wm-fm-link")!;
    expect(link.href).toBe("http://127.0.0.1:4817/doc/docs/plan.html");
    expect([link.target, link.rel]).toEqual(["_blank", "noopener"]);

    // Typing in the reply box must not reach the annotator's shortcuts.
    const box = section().querySelector("textarea")!;
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "a", altKey: true, shiftKey: true, bubbles: true, composed: true }));
    expect(annotator.getMode()).toBe("explore");

    await clock.advance(5000);
    box.value = "Thanks. Also shorten the intro.";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    section().querySelector<HTMLButtonElement>(".wm-fm-reply-form button")!.click();
    await clock.advance(0);

    expect(saved).toHaveLength(4);
    const payload = JSON.parse(saved[3].text);
    expect(payload.notes.map((n: { id: string; replies: Array<{ text: string }> }) => [n.id, n.replies.map((r) => r.text)])).toEqual([
      [noteId, ["Thanks. Also shorten the intro."]],
    ]);
    const heads = [...section().querySelectorAll(".wm-fm-reply-head")].map((h) => h.textContent!.split(" · ")[0]);
    expect(heads).toEqual(["firstmate", "you"]);
    // The new send reopens the note: it waits for the watcher again.
    expect(statusText()).toBe("Firstmate: Sent, waiting for the watcher");
    expect(section().querySelector(".wm-fm-note-state")!.textContent).toBe("Sent, waiting for the watcher");
    expect(section().querySelector("textarea")!.value).toBe("");
  });

  it("keeps an unsent reply draft when the feed redraws the thread", async () => {
    const server = fakeServer();
    const clock = fakeClock(T0);
    const { annotator } = mount(createMemoryStorage(), server, clock);
    const noteId = await seedNote(annotator);
    annotator.openSidebar();
    annotator.commands.execute("firstmate.send");
    await clock.advance(0);
    const box = () => shadow().querySelector<HTMLTextAreaElement>(".wm-fm-reply-box")!;
    box().value = "half typed";
    box().dispatchEvent(new Event("input", { bubbles: true }));

    server.publish([received({ noteIds: [noteId], state: "assigned", at: iso(T0 + 500), message: "" })]);
    await clock.advance(0);
    expect(shadow().querySelector(".wm-fm-note-state")!.textContent).toBe("Being worked on");
    expect(box().value).toBe("half typed");
  });
});
