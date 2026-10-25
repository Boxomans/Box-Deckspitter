// Box-Deckspitter app shell: constants and helpers more than one part of App uses.


export const DISCORD_INVITE = 'https://discord.gg/3qxNWFErAV';

// themes in the order the top-bar button cycles them: [id, short name, settings label, icon]
export const THEMES = [
  ['dark', 'Dark', 'Dark — charcoal & lavender', 'moon'],
  ['light', 'Light', 'Light — lilac & violet', 'sun'],
  ['dusk', 'Neon dusk', 'Neon dusk — purple, pink & cyan', 'star'],
  ['pbj', 'PB&J', 'PB&J — grape & peanut butter', 'star'],
  ['custom', 'Custom', 'Custom — your own palette', 'palette'],
];

// Easter eggs → Hidden themes adds these to the Settings theme list only (never the top-bar button or the View
// menu). Each needs its own [data-theme="id"] block in app.css, and a Monaco theme in code.js for the code editor.
// Source Code (readout) is the exception: like Custom, its colours go over the light or dark theme (custom-theme.js).
export const HIDDEN_THEMES = [
  ['f14', 'AWG-9', 'AWG-9 — F-14 radar scope', 'f14'],
  ['blood', 'Bloodflame Talons', 'Bloodflame Talons — blood & ember', 'star'],
  ['blurple', 'Blurple', 'Blurple — old-school chat app', 'star'],
  ['kabuto', 'Kabuto-chō', 'Kabuto-chō — 80s Tokyo quote board', 'activity'],
  ['temple', 'TEMPLE', 'TEMPLE — 16-colour VGA', 'star'],
  ['lubyanka', 'Lubyanka', 'Lubyanka — ministry terminal', 'file-text'],
  ['miami', 'Miami Hotline', 'Miami Hotline — 80s retrowave', 'sun'],
  ['bluehour', 'Blue hour', 'Blue hour — navy & sunset coral', 'moon'],
  ['readout', 'Source Code', 'Source Code — backlit LCD display', 'calculator'],
];

// Blue hour's skies (Settings → Appearance → Sky): [id, name, background, sun]. Dusk is the theme itself; the others are
// [data-sky] blocks in app.css, logos in assets/ and Monaco themes in code.js
export const SKIES = [
  ['dusk', 'Dusk', '#121622', 'linear-gradient(180deg, #ffe08a, #ffb15e 36%, #ff8a5c 62%, #e36bd0)'],
  ['midnight', 'Midnight', '#0c0f1a', 'linear-gradient(180deg, #f4f1ff, #d6d2f2 40%, #a99ee6 70%, #7f8fd9)'],
  ['dawn', 'Dawn', '#272b44', 'linear-gradient(180deg, #fff4c2, #ffd98a 36%, #ffb58a 62%, #ff9ec4)'],
  ['drive', 'Night drive', '#180e2c', 'linear-gradient(180deg, #ffe45c, #ffa63d 36%, #ff4f8b 62%, #d63cff)'],
  ['overcast', 'Overcast', '#1a2028', 'linear-gradient(180deg, #f2e2c4, #e6c3a6 40%, #d9a3a0 70%, #a99bb5)'],
];
// Auto's sky for an hour of the day (0-23), and the same hours in words for its tile's tooltip
export const skyAt = (hour) => hour < 5 ? 'midnight' : hour < 9 ? 'dawn' : hour < 17 ? 'overcast' : hour < 21 ? 'dusk' : 'drive';
export const SKY_HOURS = 'dawn 5–9am, overcast 9am–5pm, dusk 5–9pm, night drive 9pm–midnight, midnight until 5am';

// side panels that can move between the right sidebar and the top bar
export const SIDE_PANELS = { chars: 'Special characters', ai: 'AI assistant', clip: 'Clipboard & snippets' };
