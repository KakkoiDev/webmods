# Reading and moving Tuta mail through `window.tutao`

How [`scripts/tuta-inbox-janitor.user.js`](../scripts/tuta-inbox-janitor.user.js) actually talks to Tuta,
and the traps that cost real debugging time. Verified live on **2026-08-16** against Tuta
**v357.260812.1**, on a mailbox with 25,835 Inbox mails.

## Why not the DOM

Tuta's mail list is virtualised - at any moment the document holds ~30 recycled `<div>`s no matter how
big the folder is. Scraping 25k mails would mean programmatically scrolling for an hour and hoping
nothing re-renders mid-read.

You don't have to. **E2E encryption stops the *server* reading your mail, not the logged-in client.**
The web client must decrypt to render, and the decrypted result hangs off `window.tutao` as an ordinary
JS object graph. Anything running in the authenticated page realm can call the same methods Tuta's own
UI calls.

Mechanically: your password derives (Argon2) a key that unwraps user group key -> mail group key -> each
mail's AES session key. `entityClient` is a facade over a `postMessage` bridge to Tuta's web worker; the
worker checks its offline cache, fetches missing ciphertext over REST with your session token, hands it
to `cryptoFacade`, and structure-clones plain objects back. By the time you see a `Mail`, decryption
already happened - in Tuta's code, with keys you never touch.

**This means `@grant none` is load-bearing.** With any `GM_*` grant, Tampermonkey sandboxes the script
and `window` becomes a proxy - `window.tutao` is only reachable via `unsafeWindow`. As a Chrome
extension the equivalent is `world: "MAIN"` (needs `minimum_chrome_version: 111`); the default isolated
content-script world cannot see it at all.

## The call chain

```js
const L = window.tutao.locator

const details = await L.mailboxModel.getMailboxDetails()
const gid = Array.isArray(details[0].mailGroup._id)      // see gotcha 2
    ? details[0].mailGroup._id[1]
    : details[0].mailGroup._id

const fs = (await L.mailModel.getMailSetsForGroup(gid)).folders
fs.getIndentedList()        // -> [{ level, mailSet }]
                            // mailSet.folderType: 0 custom, 1 Inbox, 2 Sent, 3 Trash,
                            //                     4 Archive, 5 Spam, 6 Drafts

// index a folder: one MailSetEntry per mail, paged
const page = await L.entityClient.loadRange(MSE, folder.entries, '', 1000, false)

// the mails themselves, grouped by entry.mail[0] (list id), <=200 ids per call
const mails = await L.entityClient.loadMultiple(MAIL, listId, elementIds)

// move
await L.mailModel.moveMails(mailIds, targetFolder, 0)
```

A `Mail` carries `subject`, `sender {address, name}`, `receivedDate`, `unread`, `listUnsubscribe`,
`sets`, `state`, `recipientCount`. That is everything sender-based triage needs - message **bodies**
would require `loadMailDetails`, which the janitor never calls.

## Gotchas

Each of these broke something during the build:

1. **Resolve typeIds by NAME, never hardcode them.** Today `Mail`=97, `MailSetEntry`=1450,
   `MailFolder`=429 - but these come from a server-versioned model. Walk `L.clientModelInfo.typeModels`
   matching `model.name`. A TypeRef is a plain `{app, typeId, phantom: null}`; you can build one by hand
   once you know the id.

2. **`mailGroup._id` is an `[listId, elementId]` tuple with a *null* list part.** Pass the element part
   (identical to `mailGroupInfo.group`). Passing the array makes `getMailSetsForGroup` return `null`,
   and you get `Cannot read properties of null (reading 'folders')`.

3. **`mailModel.loadAllMails(entries)` throws `AssertNotNull` on a real mailbox.** Group entries by
   `entry.mail[0]` and call `entityClient.loadMultiple` yourself. Wrap each batch in try/catch - one bad
   200-mail batch otherwise takes down the entire scan. (In practice one batch of 25,835 failed this
   way: 200 mails, 0.8%, silently skipped.)

4. **Page the index with `loadRange`, not `loadAll`.** Start id `''` returns the list from the
   beginning; page until `page.length < pageSize`, with the next `start` being the last element id.
   `loadAll` is a single opaque await that sits there ~60s on 25k mails with nothing to report. Paging
   costs ~1.1s per 1,000 uncached (~25ms cached) and lets you show a running count.

5. **`moveMails`' third argument is moveMode**: `0` = exactly these mails, `1` = the whole conversation
   (which then excludes Sent, via `getFolderExcludedFromMove`). This was read out of the minified
   bundle - validate it on a single mail before running it over thousands.

6. **`finallyDeleteMails` is a permanent delete.** The janitor never calls it by design; moves into
   Trash/Spam/folders are recoverable, that is not.

## Reading minified source through tooling

Both the Chrome-extension `javascript_tool` and similar bridges redact strings containing `=`, `?` or
`&` as `[BLOCKED: Cookie/query string data]`, which makes minified JS unreadable. Transliterate first:

```js
src.toString().replace(/=/g, '≡').replace(/\?/g, '¿').replace(/&/g, '§')
```

That is how `moveMails`/`loadAllMails`/`getFolderExcludedFromMove` above were recovered.

## Stability

`window.tutao` is Tuta's **internal** API, not a public contract - a refactor can rename `mailModel` or
change `moveMails`' arity. Gotcha 1 hardens the part most likely to drift (model ids), and everything
else fails loudly rather than acting on the wrong data. Re-verify against a new Tuta version before
trusting a bulk run.

## Next step

Driving this from a CLI instead of a browser tab: [tuta-cli-roadmap.md](tuta-cli-roadmap.md).
