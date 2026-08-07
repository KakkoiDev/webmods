#!/usr/bin/env node
// Rewrites the TERMS data block inside scripts/kaikei-meet.user.js, so the userscript never
// holds hand-typed vocabulary.
//
//   node tools/gen-kaikei-terms.mjs
//
// Two sources, joined:
//   ~/.claude/skills/kaikei/reference/glossary.md   term, reading, English, note
//   ~/Code/nihongo-it-anki/decks/accounting/*.csv   English translation of each example
//
// The Anki deck carries an English `Translation` for every example sentence, so nothing here
// is machine-translated. Romaji is transliterated from the kana reading, which is mechanical.
//
// Emitted per term: j Japanese, r kana reading, o romaji, e English, n English note,
//                   xj Japanese example, xe English example, s section, se English section.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GLOSSARY = join(homedir(), '.claude/skills/kaikei/reference/glossary.md')
const ANKI = join(homedir(), 'Code/nihongo-it-anki/decks/accounting')
const TARGET = join(ROOT, 'scripts/kaikei-meet.user.js')

const BEGIN = '    /* BEGIN GENERATED TERMS */'
const END = '    /* END GENERATED TERMS */'

// ------------------------------------------------------------------ romaji

// Hepburn, longest-key-first. Covers the kana that appear in the deck's readings.
const KANA = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ー: '', '　': ' ',
}

function toRomaji(kana) {
  if (!kana) return ''
  // Katakana in a reading (e.g. じゅちゅうヘッダー) -> hiragana first.
  const hira = kana.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
  let out = ''
  let i = 0
  let sokuon = false
  while (i < hira.length) {
    if (hira[i] === 'っ') { sokuon = true; i += 1; continue }
    const two = hira.slice(i, i + 2)
    const one = hira[i]
    let r
    if (KANA[two] !== undefined) { r = KANA[two]; i += 2 }
    else if (KANA[one] !== undefined) { r = KANA[one]; i += 1 }
    else { r = one; i += 1 }
    if (sokuon && r) { out += r[0]; sokuon = false }
    out += r
  }
  return out
}

// -------------------------------------------------------------- anki join

// Minimal RFC4180 reader; the deck has quoted fields containing commas.
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1 } else quoted = false
      } else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

const translations = new Map() // term -> English example sentence
const furigana = new Map() // term -> example sentence in 漢字【かな】 form
for (const f of readdirSync(ANKI).filter((n) => /^tier\d+-vocabulary\.csv$/.test(n))) {
  const rows = parseCsv(readFileSync(join(ANKI, f), 'utf8'))
  const head = rows.shift()
  const iCloze = head.indexOf('Cloze')
  const iTrans = head.indexOf('Translation')
  const iPron = head.indexOf('Pronunciation')
  if (iCloze === -1 || iTrans === -1 || iPron === -1) {
    console.error(`${f}: missing Cloze/Translation/Pronunciation column`)
    process.exit(1)
  }
  for (const r of rows) {
    if (!r[iCloze]) continue
    const key = r[iCloze].trim()
    translations.set(key, (r[iTrans] || '').trim())
    furigana.set(key, (r[iPron] || '').trim())
  }
}

// ---------------------------------------------------------- glossary parse

// Map columns by header name, not position: some tables have a Reading column, some do not.
const COLUMN_ROLE = {
  Term: 'j', Field: 'j', Rule: 'j', Concept: 'j', Name: 'j',
  Reading: 'r',
  Meaning: 'e', English: 'e',
  Example: 'x', // Japanese example sentence
  Behaviour: 'n', Behavior: 'n', Status: 'n', Note: 'n',
  'What it means here': 'n', 'How it works today': 'n',
}

// "Tier 1 - 業務フロー / Business Flow" -> "Tier 1 - Business Flow"
// "Order header fields (受注ヘッダー)"   -> "Order header fields"
function englishSection(s) {
  const slash = /^(.*?)\s*-\s*[^\x00-\x7F].*?\/\s*(.+)$/.exec(s)
  if (slash) return `${slash[1]} - ${slash[2]}`.trim()
  return s.replace(/\s*\([^)]*[^\x00-\x7F][^)]*\)\s*$/, '').trim()
}

const terms = []
let section = ''
let roles = null

for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
  const heading = /^#{2,3}\s+(.*)$/.exec(line)
  if (heading) { section = heading[1].trim(); roles = null; continue }
  if (!line.startsWith('|')) { if (!line.trim()) roles = null; continue }

  const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
  if (/^[-: ]+$/.test(cells[0])) continue

  if (roles === null) {
    roles = cells.map((h) => {
      const role = COLUMN_ROLE[h]
      if (!role) {
        console.error(`unknown column header "${h}" under "${section}" - add it to COLUMN_ROLE`)
        process.exit(1)
      }
      return role
    })
    continue
  }

  const t = { j: '', r: '', e: '', n: '', x: '' }
  cells.forEach((v, i) => {
    const role = roles[i]
    if (!role || !v) return
    t[role] = t[role] ? `${t[role]} - ${v}` : v
  })
  // A note-only row (the "Term notes" section) is kept so the merge below can attach its
  // note to the term's real entry; a row with neither gloss nor note is decoration.
  if (!t.j || (!t.e && !t.n)) continue

  const out = { j: t.j, r: t.r, o: toRomaji(t.r), e: t.e, n: t.n, xj: t.x, xe: '', xf: '', s: section, se: englishSection(section) }
  if (out.xj) {
    out.xe = translations.get(t.j) || ''
    // Sentence in 漢字【かな】 form; the panel turns it into <ruby> furigana.
    out.xf = furigana.get(t.j) || ''
  }
  terms.push(out)
}

// A term listed in both a vocabulary tier and a field or machinery table produced two cards,
// and only the tier one carried an example sentence. Searching 消費税 could land on the
// sentence-less half. Merge on the Japanese term instead.
const byTerm = new Map()
for (const t of terms) {
  const prev = byTerm.get(t.j)
  if (!prev) { byTerm.set(t.j, t); continue }
  // The tier tables are the vocabulary home; a field table is a secondary mention, and a
  // note-only row (no English gloss) must never become the surviving entry - if it did,
  // the term would keep its note and lose its meaning.
  let base = prev
  let other = t
  if (prev.s.startsWith('Tier ') !== t.s.startsWith('Tier ')) {
    if (t.s.startsWith('Tier ')) { base = t; other = prev }
  } else if (Boolean(prev.e) !== Boolean(t.e)) {
    if (t.e) { base = t; other = prev }
  }
  for (const k of ['r', 'o', 'e', 'xj', 'xe', 'xf']) if (!base[k] && other[k]) base[k] = other[k]
  // Keep the other table's note, and its English gloss only when it says something the
  // surviving gloss does not.
  const novelGloss = other.e && !base.e.includes(other.e) && !other.e.includes(base.e) ? other.e : ''
  base.n = [base.n, other.n, novelGloss].filter(Boolean).join(' - ')
  byTerm.set(t.j, base)
}
const merged = [...byTerm.values()]
// A note row whose term matched nothing stays gloss-less. That is a typo in the notes
// table, not a term, and shipping it would put a definition-free card in the panel.
const orphans = merged.filter((t) => !t.e)
if (orphans.length) {
  console.error(`note rows matching no glossary term: ${orphans.map((t) => t.j).join(', ')}`)
  process.exit(1)
}
if (merged.length !== terms.length) console.log(`merged ${terms.length - merged.length} duplicate terms`)
terms.length = 0
terms.push(...merged)

// Drop empty fields so the embedded block stays small.
for (const t of terms) for (const k of Object.keys(t)) if (!t[k]) delete t[k]

if (terms.length < 150) {
  console.error(`refusing to write: only ${terms.length} terms parsed, expected 150+`)
  process.exit(1)
}

const withExample = terms.filter((t) => t.xj).length
const withTranslation = terms.filter((t) => t.xe).length
if (withExample !== withTranslation) {
  console.error(`${withExample - withTranslation} example sentences have no English translation`)
  process.exit(1)
}

const body = terms.map((t) => `        ${JSON.stringify(t)},`).join('\n')
const block = `${BEGIN}\n    // Generated by tools/gen-kaikei-terms.mjs - do not hand-edit.\n    const TERMS = [\n${body}\n    ];\n${END}`

const src = readFileSync(TARGET, 'utf8')
const start = src.indexOf(BEGIN)
const stop = src.indexOf(END)
if (start === -1 || stop === -1) {
  console.error(`markers not found in ${TARGET}`)
  process.exit(1)
}

writeFileSync(TARGET, src.slice(0, start) + block + src.slice(stop + END.length))
console.log(`wrote ${terms.length} terms (${withTranslation} with English examples) into ${TARGET}`)
