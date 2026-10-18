// Deep Strike's mission briefing: a few lines of made-up backdrop for each mission, the same every time for the
// same mission (built from its seed). Every name in it is invented; only the places on the map are real.

import { rng } from './geo.js';

const OPEN = [
  'Day {day} of {op}. The Eastern Pacification Zone has held its line through the thaw, but the remnant republics are rebuilding behind it.',
  'The ceasefire in the Eastern Pacification Zone lasted {weeks} weeks. Last night the remnant republics moved {what} forward again, and the Council wants an answer before dawn.',
  'Since the collapse, the remnant republics have held the country east of the Zone with borrowed missiles and old radars. Intelligence says the borrowing is about to get serious.',
  '{op} is in its {nth} month. The front in the Eastern Pacification Zone has not moved, so the Council has authorised strikes behind it.',
  'Signals traffic out of the remnant republics tripled this week. Whatever they are planning, the Directorate of Air Operations would rather it happened without {thing}.',
];

const WHY = {
  airbase: [
    '{place} is where their strike aircraft have been flying from. Close it, or take away what keeps it running.',
    'Their bombers have been staging through {place}. Every night it stays open, the Zone takes another raid.',
    'Reconnaissance puts fresh aircraft on the ramp at {place}. Hit it before they are dispersed.',
  ],
  sam: [
    '{A} {sam} battery {where} now covers most of the approaches. Until it goes, nothing of ours flies east with any confidence.',
    'They have moved {a} {sam} forward to a site {where}. It pushes their umbrella a hundred kilometres closer to the Zone.',
    'The {sam} {where} is the cornerstone of their air defence in this sector. Take it out and the rest of the network has a hole in it.',
  ],
  industry: [
    'The works {where} turn out the shells and fuel their front line runs on.',
    'Intelligence links the complex {where} to their drone and missile repair programme.',
    'The plant {where} keeps the lights on for half their logistics in this sector.',
  ],
};

const WARN = [
  'Expect a layered air defence: long-range systems behind, mobile systems that only switch on when they have to.',
  'Their mobile batteries shift every few days; what the last sortie saw may not be where it was.',
  'The network is old in places and new in others. Find out which before you commit the package.',
  'The sniffer goes first. Do not send jets into a network nobody has listened to.',
];

const CLOSE = [
  'Objective {code}. Budget is {budget}; the Council will not sign for more.',
  'Objective {code}. You have {budget} and whatever the sniffer brings back.',
  'Objective {code}. Spend the {budget} wisely; the airframes are harder to replace than the money.',
];

const OPS = ['Operation Long Winter', 'Operation Quiet River', 'Operation Black Steppe', 'Operation Iron Harvest', 'Operation Grey Line', 'Operation Lantern'];
const WHAT = ['armour', 'artillery', 'air defence', 'supply columns', 'fresh battalions'];
const THING = ['us noticing', 'air cover', 'interference', 'a reply'];
const NTH = ['second', 'third', 'fourth', 'fifth', 'seventh', 'ninth'];

/** The briefing for a mission: an array of paragraphs. */
export function briefing(m, { place, where, sam, budget }) { // where: "at Town" or "38 km NE of Town"
  const r = rng((m.seed ^ 0x5bd1e995) >>> 0);
  const an = /^(S-|[AEIOU])/.test(sam || ''); // "an S-400"
  const fill = (s) => s
    .replace('{day}', String(r.int(40, 900)))
    .replace('{weeks}', String(r.int(3, 19)))
    .replace('{op}', r.pick(OPS))
    .replace('{nth}', r.pick(NTH))
    .replace('{what}', r.pick(WHAT))
    .replace('{thing}', r.pick(THING))
    .replace('{place}', place)
    .replace('{where}', where)
    .replace('{A}', an ? 'An' : 'A')
    .replace('{a}', an ? 'an' : 'a')
    .replace('{sam}', sam || 'surface-to-air')
    .replace('{code}', m.code)
    .replace('{budget}', budget);
  return [fill(r.pick(OPEN)), fill(r.pick(WHY[m.type])), fill(r.pick(WARN)), fill(r.pick(CLOSE))];
}
