// Box-DocSpitter app shell: constants and helpers more than one part of App uses.


export const DISCORD_INVITE = 'https://discord.gg/3qxNWFErAV';

// themes in the order the top-bar button cycles them: [id, short name, settings label, icon]
export const THEMES = [
  ['dark', 'Dark', 'Dark — neon dusk', 'moon'],
  ['light', 'Light', 'Light — lavender', 'sun'],
  ['pbj', 'PB&J', 'PB&J — grape & peanut butter', 'star'],
  ['custom', 'Custom', 'Custom — your own palette', 'palette'],
];

// Easter eggs → Hidden themes adds these to the Settings theme list only (never the top-bar button or the View
// menu). Each needs its own [data-theme="id"] block in app.css, and a Monaco theme in code.js for the code editor.
export const HIDDEN_THEMES = [
  ['f14', 'AWG-9', 'AWG-9 — F-14 radar scope', 'f14'],
  ['blood', 'Bloodflame Talons', 'Bloodflame Talons — blood & ember', 'star'],
  ['blurple', 'Blurple', 'Blurple — old-school chat app', 'star'],
  ['kabuto', 'Kabuto-chō', 'Kabuto-chō — 80s Tokyo quote board', 'activity'],
  ['temple', 'TEMPLE', 'TEMPLE — 16-colour VGA', 'star'],
  ['lubyanka', 'Lubyanka', 'Lubyanka — ministry terminal', 'file-text'],
  ['miami', 'Miami Hotline', 'Miami Hotline — 80s retrowave', 'sun'],
];

// side panels that can move between the right sidebar and the top bar
export const SIDE_PANELS = { chars: 'Special characters', ai: 'Ask Claude', clip: 'Clipboard & snippets' };
