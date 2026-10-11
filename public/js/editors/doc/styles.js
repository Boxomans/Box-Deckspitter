// Shared document content styles — used by the editor, print, PDF export and HTML export.

export const PAGE_SIZES = {
  letter: { w: 8.5, h: 11, label: 'Letter · 8.5 × 11 in' },
  legal: { w: 8.5, h: 14, label: 'Legal · 8.5 × 14 in' },
  a4: { w: 8.27, h: 11.69, label: 'A4 · 210 × 297 mm' },
  a5: { w: 5.83, h: 8.27, label: 'A5 · 148 × 210 mm' },
  tabloid: { w: 11, h: 17, label: 'Tabloid · 11 × 17 in' },
  executive: { w: 7.25, h: 10.5, label: 'Executive · 7.25 × 10.5 in' },
};

export const FONTS = [
  'Arial', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel',
  'Courier New', 'Franklin Gothic Medium', 'Garamond', 'Georgia', 'IBM Plex Mono', 'Impact', 'Inter', 'Lucida Console',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
];

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96];

/** Word "single" spacing ≈ 1.15 CSS line-height for typical fonts. */
export const LH_FACTOR = 1.15;

export function pageDims(page) {
  const base = page.size === 'custom' ? { w: page.w, h: page.h } : PAGE_SIZES[page.size] || PAGE_SIZES.letter;
  return page.orientation === 'landscape' ? { w: base.h, h: base.w } : { w: base.w, h: base.h };
}

export function fontStack(name) {
  const fallbacks = {
    Calibri: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif",
    Cambria: "Cambria, Caladea, Georgia, serif",
    'Times New Roman': "'Times New Roman', Tinos, Times, serif",
    Arial: "Arial, Arimo, Helvetica, sans-serif",
    'Courier New': "'Courier New', Cousine, monospace",
    Inter: "Inter, 'Segoe UI', sans-serif",
  };
  return fallbacks[name] || `'${name}', sans-serif`;
}

const CHECK_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E";

export function docContentCss(sel = '.doc-body') {
  return `
${sel} {
  font-family: var(--doc-font, Calibri, Carlito, Arial, sans-serif);
  font-size: var(--doc-size, 11pt);
  line-height: var(--doc-lh, 1.15);
  color: #1d1b22;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 48px;
  -moz-tab-size: 48px;
}
${sel} p { margin: 0 0 var(--doc-after, 6pt); }
${sel} div { margin: 0; }
${sel} h1, ${sel} h2, ${sel} h3, ${sel} h4, ${sel} h5, ${sel} h6 { font-weight: 600; line-height: 1.25; color: #1b1824; }
${sel} h1 { font-size: 20pt; margin: 18pt 0 6pt; }
${sel} h2 { font-size: 16pt; margin: 14pt 0 4pt; }
${sel} h3 { font-size: 13.5pt; margin: 12pt 0 4pt; color: #3a3648; }
${sel} h4 { font-size: 12pt; margin: 10pt 0 4pt; color: #4b4760; }
${sel} h5 { font-size: 11pt; margin: 10pt 0 3pt; color: #4b4760; }
${sel} h6 { font-size: 11pt; margin: 10pt 0 3pt; color: #4b4760; font-style: italic; }
${sel} > :first-child { margin-top: 0; }
${sel} p.title { font-size: 26pt; line-height: 1.15; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4pt; color: #15121d; }
${sel} p.subtitle { font-size: 14pt; color: #6b6680; margin: 0 0 14pt; }
${sel} blockquote { margin: 6pt 0 10pt; padding: 2pt 0 2pt 12pt; border-left: 3px solid #b9a6e4; color: #4e4a5c; font-style: italic; }
${sel} blockquote p:last-child { margin-bottom: 0; }
${sel} pre { font-family: Consolas, 'IBM Plex Mono', 'Courier New', monospace; font-size: 10pt; line-height: 1.45; background: #f5f3f9; border: 1px solid #e4dfee; border-radius: 4px; padding: 8pt 10pt; margin: 4pt 0 10pt; white-space: pre-wrap; }
${sel} code { font-family: Consolas, 'IBM Plex Mono', monospace; font-size: 0.92em; background: #f3f0f8; padding: 0 3px; border-radius: 3px; }
${sel} pre code { background: none; padding: 0; }
${sel} ul, ${sel} ol { margin: 0 0 var(--doc-after, 6pt); padding-left: 2.1em; }
${sel} li { margin: 0; }
${sel} li > p { margin: 0; }
${sel} li > ul, ${sel} li > ol { margin-bottom: 0; }
${sel} ul.checklist { list-style: none; padding-left: 1.75em; }
${sel} ul.checklist > li { position: relative; }
${sel} ul.checklist > li::before {
  content: ''; position: absolute; left: -1.55em; top: 0.18em; width: 0.95em; height: 0.95em;
  border: 1.5px solid #8a84a0; border-radius: 3px; box-sizing: border-box; cursor: pointer;
}
${sel} ul.checklist > li[data-checked="true"] { color: #8a84a0; text-decoration: line-through; }
${sel} ul.checklist > li[data-checked="true"]::before { background: #7a4fd6 url("${CHECK_SVG}") center / 85% no-repeat; border-color: #7a4fd6; }
${sel} table { border-collapse: collapse; width: 100%; margin: 4pt 0 10pt; }
${sel} td, ${sel} th { border: 1px solid #b9b3c6; padding: 4pt 6pt; vertical-align: top; min-width: 20px; }
${sel} th { background: #f3f0f8; font-weight: 600; text-align: left; }
${sel} table.plain td, ${sel} table.plain th { border-color: transparent; }
${sel} td > p:last-child, ${sel} th > p:last-child { margin-bottom: 0; }
${sel} img { max-width: 100%; height: auto; }
${sel} img.float-left { float: left; margin: 2pt 12pt 6pt 0; }
${sel} img.float-right { float: right; margin: 2pt 0 6pt 12pt; }
${sel} img.center { display: block; margin: 6pt auto; }
${sel} hr { border: 0; border-top: 1px solid #c9c3d6; margin: 12pt 0; }
${sel} a { color: #1155cc; text-decoration: underline; }
${sel} .textbox { border: 1px solid #c9c3d6; padding: 6pt 8pt; margin: 6pt 0; }
${sel} .toc { margin: 0 0 12pt; }
${sel} .toc p { margin: 0 0 2pt; }
${sel} .toc a { color: inherit; text-decoration: none; }
${sel} sup, ${sel} sub { font-size: 0.7em; line-height: 0; }
`;
}

/** Extra rules only for print/PDF output. */
export function printCss(page) {
  const d = pageDims(page);
  const m = page.margins;
  return `
@page { size: ${d.w}in ${d.h}in; margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; }
html, body { margin: 0; padding: 0; background: #fff; }
.page-break { break-after: page; page-break-after: always; height: 0; border: 0; margin: 0; }
table.plain td, table.plain th { border-color: transparent !important; }
.doc-body h1, .doc-body h2, .doc-body h3, .doc-body h4 { break-after: avoid; page-break-after: avoid; }
tr, img { break-inside: avoid; page-break-inside: avoid; }
`;
}
