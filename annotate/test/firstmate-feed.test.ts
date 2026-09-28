import { describe, expect, it } from "vitest";
import {
  NO_RECEIPT_MS,
  STALE_AFTER_MS,
  backoffMs,
  noteProgress,
  pathUnderRoot,
  repliesFor,
  replyHref,
  sendProgress,
  startFeed,
  type FeedResponse,
  type FirstmateFeed,
  type FirstmateStatus,
  type LocalSend,
  type Timers,
} from "../src/plugins/firstmate-feed";

const T0 = Date.UTC(2026, 8, 28, 3, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const send: LocalSend = { source: "firstmate-annotate-20260928T030000.000Z.json", sentAt: T0, noteIds: ["n1", "n2"] };

function status(over: Partial<FirstmateStatus> = {}): FirstmateStatus {
  return { requestId: "r1", state: "received", at: iso(T0 + 200), source: send.source, sentAt: iso(T0), noteIds: ["n1", "n2"], ...over };
}

describe("send progress", () => {
  it("walks sent, no receipt, received, working, stale, done and failed", () => {
    expect(sendProgress(send, [], T0 + 100).progress).toBe("sent");
    expect(sendProgress(send, [], T0 + NO_RECEIPT_MS - 1).progress).toBe("sent");
    expect(sendProgress(send, [], T0 + NO_RECEIPT_MS).progress).toBe("no-receipt");
    expect(sendProgress(send, [status()], T0 + NO_RECEIPT_MS * 5).progress).toBe("received");

    const assigned = status({ state: "assigned", at: iso(T0 + 1000), message: "crewmate on it" });
    expect(sendProgress(send, [assigned], T0 + 2000)).toEqual({ progress: "working", message: "crewmate on it", at: T0 + 1000 });
    expect(sendProgress(send, [assigned], T0 + 1000 + STALE_AFTER_MS).progress).toBe("working");
    expect(sendProgress(send, [assigned], T0 + 1001 + STALE_AFTER_MS).progress).toBe("stale");

    expect(sendProgress(send, [status({ state: "done", message: "fixed" })], T0).message).toBe("fixed");
    expect(sendProgress(send, [status({ state: "failed" })], T0).progress).toBe("failed");
  });

  it("matches a status by source file, else by sentAt, and ignores other sends", () => {
    const other = status({ requestId: "r0", source: "older.json", sentAt: iso(T0 - 60_000), state: "done" });
    expect(sendProgress(send, [other], T0 + 1).progress).toBe("sent");
    expect(sendProgress(send, [other, status({ source: "renamed.json", state: "assigned", at: iso(T0) })], T0 + 1).progress).toBe(
      "working"
    );
  });
});

describe("note progress and replies", () => {
  const reply = (over: object) => ({ noteId: "n1", author: "firstmate", at: iso(T0 + 5000), text: "Fixed in plan.md\nmore", ...over });

  it("takes the newest status that carries the note", () => {
    const old = status({ requestId: "r0", sentAt: iso(T0 - 60_000), state: "done", noteIds: ["n1"] });
    const now = status({ state: "assigned", at: iso(T0 + 1000), noteIds: ["n1"] });
    expect(noteProgress("n1", [now, old], T0 + 2000)?.progress).toBe("working");
    expect(noteProgress("n2", [old], T0)).toBeNull();
  });

  it("marks a note done by a done reply newer than its last send, not by an older one", () => {
    const assigned = status({ state: "assigned", at: iso(T0 + 1000) });
    const closed = { ...assigned, replies: [reply({ done: true })] };
    expect(noteProgress("n1", [closed], T0 + 6000)).toEqual({ progress: "done", message: "Fixed in plan.md", at: T0 + 5000 });
    expect(noteProgress("n2", [closed], T0 + 6000)?.progress).toBe("working");

    // The captain replied again after that: the new send reopens the note.
    const resent = status({ requestId: "r2", sentAt: iso(T0 + 9000), at: iso(T0 + 9100), source: "b.json", noteIds: ["n1"] });
    expect(noteProgress("n1", [closed, resent], T0 + 9500)?.progress).toBe("received");
  });

  it("gathers a note's replies across statuses, oldest first, skipping malformed ones", () => {
    const a = status({ replies: [reply({ at: iso(T0 + 3000), text: "second" }), reply({ noteId: "n2", text: "other" })] });
    const b = status({ requestId: "r2", replies: [reply({ at: iso(T0 + 1000), text: "first" }), { noteId: "n1" } as never] });
    expect(repliesFor("n1", [a, b]).map((r) => r.text)).toEqual(["first", "second"]);
  });
});

describe("reply links", () => {
  const root = ["firstmate-annotate"];

  it("turns a path or file:// URL under the root into the server's /doc/ URL", () => {
    expect(replyHref("/Users/me/Downloads/firstmate-annotate/docs/plan v2.html", root, 4817, false)).toBe(
      "http://127.0.0.1:4817/doc/docs/plan%20v2.html"
    );
    expect(replyHref("file:///Users/me/Downloads/firstmate-annotate/docs/plan%20v2.html", root, 5000, false)).toBe(
      "http://127.0.0.1:5000/doc/docs/plan%20v2.html"
    );
    expect(pathUnderRoot("/a/firstmate-annotate/x/firstmate-annotate/y.md", root)).toEqual(["y.md"]);
  });

  it("passes http(s) through and drops everything else from a web page", () => {
    expect(replyHref("https://github.com/o/r/pull/1", root, 4817, false)).toBe("https://github.com/o/r/pull/1");
    expect(replyHref("javascript:alert(1)", root, 4817, false)).toBeNull();
    expect(replyHref("/Users/me/elsewhere/doc.html", root, 4817, false)).toBeNull();
    expect(replyHref("/Users/me/Downloads/firstmate-annotate/../secret", root, 4817, false)).toBeNull();
    expect(replyHref("/Users/me/elsewhere/doc.html", root, 4817, true)).toBe("file:///Users/me/elsewhere/doc.html");
    expect(replyHref(null, root, 4817, false)).toBeNull();
  });
});

/** Timers run by hand: `run()` fires the earliest pending timer. */
function manualTimers() {
  const pending: Array<{ run: () => void; ms: number; id: number }> = [];
  let next = 0;
  const timers: Timers = {
    set: (run, ms) => (pending.push({ run, ms, id: ++next }), next),
    clear: (id) => {
      const at = pending.findIndex((t) => t.id === id);
      if (at >= 0) pending.splice(at, 1);
    },
  };
  return {
    timers,
    delays: () => pending.map((t) => t.ms),
    async run() {
      pending.sort((a, b) => a.ms - b.ms);
      pending.shift()?.run();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const feed = (version: string, statuses: FirstmateStatus[] = []): FeedResponse => ({
  status: 200,
  text: JSON.stringify({ format: "wm-annotate-firstmate-feed", schemaVersion: 1, folder: "f", version, now: iso(T0), statuses }),
});

describe("startFeed", () => {
  it("backs off 0.5, 1, 2, 4, then 5 s", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  it("re-polls with the last version, reconnects with backoff after the server goes away, and stops", async () => {
    const clock = manualTimers();
    const answers: Array<() => Promise<FeedResponse>> = [
      async () => feed("v1", [status()]),
      async () => feed("v1"),
      async () => Promise.reject(new Error("ECONNREFUSED")),
      async () => Promise.reject(new Error("ECONNREFUSED")),
      async () => ({ status: 503, text: "" }),
      async () => feed("v2"),
    ];
    const urls: string[] = [];
    const feeds: FirstmateFeed[] = [];
    const connection: boolean[] = [];
    const loop = startFeed({
      timers: clock.timers,
      request: (url) => (urls.push(url), answers.shift()!()),
      url: (since) => `since=${since}`,
      onFeed: (f) => feeds.push(f),
      onConnection: (on) => connection.push(on),
    });

    await clock.run();
    expect(feeds.map((f) => f.version)).toEqual(["v1"]);
    await clock.run(); // same version again: no new feed
    expect(feeds).toHaveLength(1);
    await clock.run();
    expect(clock.delays()).toEqual([500]);
    await clock.run();
    expect(clock.delays()).toEqual([1000]);
    await clock.run();
    expect(clock.delays()).toEqual([2000]);
    await clock.run();
    expect(urls).toEqual(["since=", "since=v1", "since=v1", "since=", "since=", "since="]);
    expect(feeds.map((f) => f.version)).toEqual(["v1", "v2"]);
    expect(connection).toEqual([true, true, false, false, false, true]);

    loop.stop();
    expect(clock.delays()).toEqual([]);
  });
});
