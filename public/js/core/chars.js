// Special characters: every Windows Alt code plus the useful Unicode symbol blocks.

// Alt+1 … Alt+255 use the OEM code page (CP437).
const CP437_LOW = '☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼';
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function altCodes() {
  const out = [];
  for (let i = 1; i <= 255; i++) {
    let ch;
    if (i < 32) ch = CP437_LOW[i - 1];
    else if (i < 127) ch = String.fromCharCode(i);
    else if (i === 127) ch = '⌂';
    else ch = CP437_HIGH[i - 128];
    if (i === 32) continue;
    out.push({ ch, alt: String(i) });
  }
  return out;
}

function altZeroCodes() {
  const dec = new TextDecoder('windows-1252');
  const out = [];
  for (let i = 128; i <= 255; i++) {
    if ([0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(i)) continue;
    const ch = dec.decode(new Uint8Array([i]));
    out.push({ ch, alt: '0' + i });
  }
  return out;
}

const SKIP = /[\p{Cn}\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function range(...pairs) {
  const out = [];
  for (const [a, b] of pairs) {
    for (let cp = a; cp <= b; cp++) {
      const ch = String.fromCodePoint(cp);
      if (SKIP.test(ch)) continue;
      out.push({ ch });
    }
  }
  return out;
}

export const CHAR_SETS = [
  { id: 'recent', label: 'Recent' },
  { id: 'alt', label: 'Alt codes', note: 'Hold Alt and type the number on the numpad', build: altCodes },
  { id: 'alt0', label: 'Alt+0 codes', note: 'Hold Alt and type 0 + the number on the numpad', build: altZeroCodes },
  { id: 'punct', label: 'Punctuation', build: () => range([0x2010, 0x2027], [0x2030, 0x205e], [0x00a1, 0x00bf], [0x2e18, 0x2e19], [0x3001, 0x3003]) },
  { id: 'currency', label: 'Currency', build: () => [...'$¢£¤¥₠₡₢₣₤₥₦₧₨₩₪₫€₭₮₯₰₱₲₳₴₵₶₷₸₹₺₻₼₽₾₿⃀'].map((ch) => ({ ch })) },
  { id: 'arrows', label: 'Arrows', build: () => range([0x2190, 0x21ff], [0x27f0, 0x27ff], [0x2900, 0x297f], [0x2b00, 0x2b2f], [0x2b30, 0x2b4f]) },
  { id: 'math', label: 'Math', build: () => range([0x2200, 0x22ff], [0x2a00, 0x2a1f], [0x00b1, 0x00b1], [0x00d7, 0x00d7], [0x00f7, 0x00f7], [0x27c0, 0x27ef]) },
  { id: 'scripts', label: 'Super & subscript', build: () => range([0x2070, 0x209c], [0x00b2, 0x00b3], [0x00b9, 0x00b9], [0x1d43, 0x1d6a]) },
  { id: 'fractions', label: 'Fractions & numbers', build: () => range([0x00bc, 0x00be], [0x2150, 0x218b], [0x2460, 0x24ff], [0x2776, 0x2793], [0x3251, 0x325f], [0x32b1, 0x32bf]) },
  { id: 'letterlike', label: 'Letterlike', build: () => range([0x2100, 0x214f], [0x00a9, 0x00a9], [0x00ae, 0x00ae]) },
  { id: 'greek', label: 'Greek', build: () => range([0x0391, 0x03a9], [0x03b1, 0x03c9], [0x03d0, 0x03ff]) },
  { id: 'latin', label: 'Latin accents', build: () => range([0x00c0, 0x00ff], [0x0100, 0x017f], [0x0180, 0x024f], [0x1e00, 0x1eff]) },
  { id: 'ipa', label: 'IPA & phonetic', build: () => range([0x0250, 0x02af], [0x02b0, 0x02ff]) },
  { id: 'cyrillic', label: 'Cyrillic', build: () => range([0x0400, 0x045f]) },
  { id: 'box', label: 'Box drawing', build: () => range([0x2500, 0x257f], [0x2580, 0x259f]) },
  { id: 'shapes', label: 'Shapes', build: () => range([0x25a0, 0x25ff], [0x2b1b, 0x2b2f], [0x2b50, 0x2b59]) },
  { id: 'technical', label: 'Technical', build: () => range([0x2300, 0x23ff], [0x2400, 0x2426]) },
  { id: 'symbols', label: 'Misc symbols', build: () => range([0x2600, 0x26ff]) },
  { id: 'dingbats', label: 'Dingbats', build: () => range([0x2700, 0x27bf]) },
  { id: 'braille', label: 'Braille', build: () => range([0x2800, 0x28ff]) },
  { id: 'music', label: 'Music & games', build: () => range([0x2669, 0x266f], [0x1d100, 0x1d126], [0x1d129, 0x1d1e8], [0x2654, 0x265f], [0x1f0a0, 0x1f0f5], [0x2680, 0x2685]) },
  { id: 'emoji-faces', label: 'Emoji · faces', build: () => range([0x1f600, 0x1f64f], [0x1f910, 0x1f92f], [0x1f970, 0x1f97a]) },
  { id: 'emoji-people', label: 'Emoji · people', build: () => range([0x1f440, 0x1f4af], [0x1f645, 0x1f64f], [0x1f930, 0x1f93e], [0x1f9b0, 0x1f9ff]) },
  { id: 'emoji-nature', label: 'Emoji · nature & food', build: () => range([0x1f300, 0x1f37f], [0x1f400, 0x1f43f], [0x1f980, 0x1f9ae], [0x1f950, 0x1f96f]) },
  { id: 'emoji-objects', label: 'Emoji · objects', build: () => range([0x1f380, 0x1f3ff], [0x1f4b0, 0x1f4ff], [0x1f500, 0x1f5ff]) },
  { id: 'emoji-travel', label: 'Emoji · travel', build: () => range([0x1f680, 0x1f6ff], [0x1fa70, 0x1faff]) },
];

// keyword index for the most commonly hunted-for characters
const NAMES = {
  '©': 'copyright', '®': 'registered trademark', '™': 'trademark tm', '°': 'degree', '±': 'plus minus', '×': 'times multiply',
  '÷': 'divide division', '€': 'euro', '£': 'pound sterling', '¥': 'yen yuan', '¢': 'cent', '§': 'section', '¶': 'paragraph pilcrow',
  '•': 'bullet dot', '·': 'middle dot interpunct', '…': 'ellipsis dots', '–': 'en dash', '—': 'em dash', '‘': 'left single quote',
  '’': 'right single quote apostrophe', '“': 'left double quote', '”': 'right double quote', '«': 'left guillemet', '»': 'right guillemet',
  '†': 'dagger', '‡': 'double dagger', '‰': 'per mille', '√': 'square root radical', '∞': 'infinity', '≈': 'approximately almost equal',
  '≠': 'not equal', '≤': 'less than or equal', '≥': 'greater than or equal', 'π': 'pi', 'Σ': 'sigma sum', 'µ': 'micro mu', 'Ω': 'omega ohm',
  'Δ': 'delta', 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'θ': 'theta', 'λ': 'lambda', 'φ': 'phi', '½': 'half', '¼': 'quarter',
  '¾': 'three quarters', '²': 'squared superscript two', '³': 'cubed superscript three', '¹': 'superscript one', '→': 'right arrow',
  '←': 'left arrow', '↑': 'up arrow', '↓': 'down arrow', '↔': 'left right arrow', '⇒': 'implies double arrow', '✓': 'check mark tick',
  '✔': 'heavy check mark', '✗': 'cross x ballot', '✘': 'heavy cross', '★': 'star black', '☆': 'star white', '♥': 'heart',
  '♦': 'diamond', '♣': 'club', '♠': 'spade', '♪': 'music note', '♫': 'music notes', '☺': 'smiley face', '☻': 'smiley black',
  '☼': 'sun', '☀': 'sun', '☁': 'cloud', '☂': 'umbrella', '☃': 'snowman', '☎': 'telephone phone', '✉': 'envelope mail',
  '✂': 'scissors', '✈': 'airplane', '⌘': 'command key', '⌥': 'option key', '⇧': 'shift key', '⌫': 'backspace delete',
  '⏎': 'return enter', '⌂': 'house', '☐': 'ballot box unchecked', '☑': 'ballot box checked', '☒': 'ballot box x', '¿': 'inverted question',
  '¡': 'inverted exclamation', 'ñ': 'n tilde', 'Ñ': 'n tilde', 'é': 'e acute', 'è': 'e grave', 'ü': 'u umlaut', 'ö': 'o umlaut',
  'ä': 'a umlaut', 'ß': 'eszett sharp s', 'ç': 'c cedilla', 'ø': 'o slash', 'å': 'a ring', 'æ': 'ae ligature', 'œ': 'oe ligature',
  ' ': 'non-breaking space nbsp', '‑': 'non-breaking hyphen', '′': 'prime minute feet', '″': 'double prime seconds inches',
  '℃': 'celsius', '℉': 'fahrenheit', '№': 'numero number', '℅': 'care of', 'ª': 'feminine ordinal', 'º': 'masculine ordinal',
  '∑': 'summation', '∏': 'product', '∫': 'integral', '∂': 'partial derivative', '∇': 'nabla del', '∈': 'element of', '∅': 'empty set',
  '∩': 'intersection', '∪': 'union', '⊂': 'subset', '∧': 'and logical', '∨': 'or logical', '¬': 'not logical', '∀': 'for all',
  '∃': 'there exists', '∴': 'therefore', '∵': 'because', '≡': 'identical congruent', '∝': 'proportional', '‰': 'permille',
  '₿': 'bitcoin', '₹': 'rupee', '₩': 'won', '₽': 'ruble', '₺': 'lira', '¤': 'currency sign', '░': 'shade light', '▒': 'shade medium',
  '▓': 'shade dark', '█': 'full block', '■': 'square black', '□': 'square white', '▲': 'triangle up', '▼': 'triangle down',
  '►': 'triangle right pointer', '◄': 'triangle left pointer', '●': 'circle black', '○': 'circle white', '◆': 'diamond black',
  '◇': 'diamond white', '♀': 'female', '♂': 'male', '☢': 'radioactive', '☣': 'biohazard', '☮': 'peace', '☯': 'yin yang',
  '♻': 'recycle', '⚠': 'warning', '⚡': 'lightning high voltage', '☕': 'coffee', '⌛': 'hourglass', '⏰': 'alarm clock',
  '❤': 'heart red', '❄': 'snowflake', '✏': 'pencil', '✒': 'pen nib', '✍': 'writing hand', '☠': 'skull crossbones',
};

const cache = new Map();
export function charsFor(id) {
  if (!cache.has(id)) {
    if (id === 'all') {
      // every category in one list, each character once
      const seen = new Set();
      const all = [];
      for (const set of CHAR_SETS) {
        if (!set.build) continue;
        for (const x of charsFor(set.id)) if (!seen.has(x.ch)) { seen.add(x.ch); all.push(x); }
      }
      cache.set(id, all);
    } else {
      const set = CHAR_SETS.find((s) => s.id === id);
      cache.set(id, set?.build ? set.build() : []);
    }
  }
  return cache.get(id);
}

// Official Unicode names for every character in the panel (generated from the Unicode database),
// loaded on first use so searching "point", "arrow", "heart"… finds matches in every category.
let FULL_NAMES = null;
let namesPromise = null;
export function loadCharNames() {
  namesPromise ||= fetch('/js/core/char-names.json').then((r) => r.json()).then((j) => { FULL_NAMES = j; return j; }).catch(() => null);
  return namesPromise;
}
const fullName = (ch) => (FULL_NAMES ? FULL_NAMES[ch.codePointAt(0)] || '' : '');

/** Alt code lookup for a character (prefers Alt+0 code as Windows does). */
const altIndex = (() => {
  let m = null;
  return (ch) => {
    if (!m) {
      m = new Map();
      for (const x of altCodes()) if (!m.has(x.ch)) m.set(x.ch, x.alt);
      for (const x of altZeroCodes()) m.set(x.ch, x.alt);
    }
    return m.get(ch) || null;
  };
})();

export function describe(ch) {
  const cp = ch.codePointAt(0);
  return {
    ch,
    hex: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
    dec: cp,
    alt: altIndex(ch),
    html: `&#${cp};`,
    name: NAMES[ch] || fullName(ch),
  };
}

/** Search all sets by keyword, alt code, U+hex, or the character itself. */
export function searchChars(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const seen = new Set();
  const out = [];
  const push = (ch) => { if (!seen.has(ch)) { seen.add(ch); out.push({ ch }); } };
  // direct character
  if ([...q.trim()].length === 1) push(q.trim());
  // alt code
  if (/^\d{1,4}$/.test(s)) {
    for (const x of altZeroCodes()) if (x.alt === s || x.alt === s.padStart(4, '0')) push(x.ch);
    if (s.length <= 3) for (const x of altCodes()) if (x.alt === String(Number(s))) push(x.ch);
  }
  // code point
  const hm = /^(?:u\+|0x|\\u)?([0-9a-f]{2,6})$/.exec(s);
  if (hm && !/^\d{1,3}$/.test(s)) { const cp = parseInt(hm[1], 16); if (cp > 31 && cp < 0x10ffff) push(String.fromCodePoint(cp)); }
  // names: every word has to match ("left arrow", "black heart"); hand-picked names first, then Unicode names
  let words = s.split(/\s+/).filter(Boolean);
  // "emoji" isn't part of any official name: treat it as a filter ("pointing emoji", "heart emoji")
  const emojiOnly = words.some((w) => /^emojis?$/.test(w));
  if (emojiOnly) words = words.filter((w) => !/^emojis?$/.test(w));
  const isEmoji = (ch) => ch.codePointAt(0) >= 0x1f000 || /\p{Extended_Pictographic}/u.test(ch);
  if (emojiOnly && !words.length) {
    for (const set of CHAR_SETS) if (set.id.startsWith('emoji') && set.build) for (const x of charsFor(set.id)) push(x.ch);
    return out.slice(0, 600);
  }
  const matches = (name) => words.every((w) => name.includes(w));
  if (!emojiOnly) for (const [ch, name] of Object.entries(NAMES)) if (matches(name)) push(ch);
  if (FULL_NAMES) {
    const whole = [];
    const part = [];
    for (const [cp, name] of Object.entries(FULL_NAMES)) {
      if (!matches(name)) continue;
      // whole-word hits ("point" in "four-pointed star" is still a hit, but "pointing" comes later)
      (words.every((w) => new RegExp(`(^|[^a-z])${w.replace(/[^a-z0-9]/g, '')}([^a-z]|$)`).test(name)) ? whole : part).push(String.fromCodePoint(Number(cp)));
    }
    // picture emoji (👆😳) first, then emoji-capable symbols (☝⏩), then everything else
    const tier = (c) => (c.codePointAt(0) >= 0x1f000 ? 0 : isEmoji(c) ? 1 : 2);
    const emojiFirst = (list) => list.filter((c) => !emojiOnly || tier(c) < 2).sort((a, b) => tier(a) - tier(b));
    for (const ch of [...emojiFirst(whole), ...emojiFirst(part)]) push(ch);
  }
  // set labels
  for (const set of CHAR_SETS) if (set.build && set.label.toLowerCase().includes(s)) for (const x of charsFor(set.id).slice(0, 120)) push(x.ch);
  return out.slice(0, 600);
}
