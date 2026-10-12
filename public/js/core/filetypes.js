// File type → editor mode / language detection.

import { extOf, basename, looksLikeText } from './dom.js';

export const DOC_EXT = ['docx', 'docm', 'dotx', 'odt', 'rtf'];
export const TEXT_EXT = ['txt', 'text', 'log', 'nfo', 'diz', 'asc', 'me', '1st', 'readme', 'out', 'srt', 'vtt', 'lrc'];
export const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv', 'fods'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg', 'apng'];
export const PDF_EXT = ['pdf'];
export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'avi', 'wmv', '3gp', 'mts', 'm2ts', 'flv', 'mp3', 'wav', 'm4a', 'aac', 'oga', 'opus', 'flac', 'weba'];

// extension → Monaco language id
export const CODE_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', har: 'json', ipynb: 'json', geojson: 'json',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html', astro: 'html', hbs: 'handlebars', handlebars: 'handlebars',
  xml: 'xml', xsl: 'xml', xslt: 'xml', xsd: 'xml', plist: 'xml', csproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml',
  resx: 'xml', xaml: 'xml', rss: 'xml', atom: 'xml', kml: 'xml', gpx: 'xml', config: 'xml', manifest: 'xml', nuspec: 'xml', wsdl: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', mdown: 'markdown',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', cnf: 'ini', properties: 'ini', env: 'ini', reg: 'ini', inf: 'ini',
  editorconfig: 'ini', npmrc: 'ini', gitconfig: 'ini', desktop: 'ini', service: 'ini', prefs: 'ini',
  py: 'python', pyw: 'python', pyi: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', groovy: 'java', gradle: 'java', swift: 'swift', dart: 'dart',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  cs: 'csharp', csx: 'csharp', fs: 'fsharp', fsx: 'fsharp', vb: 'vb',
  php: 'php', phtml: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir', clj: 'clojure',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell', bashrc: 'shell', zshrc: 'shell', profile: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  sql: 'sql', mysql: 'mysql', pgsql: 'pgsql',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf', tf: 'hcl', hcl: 'hcl', tfvars: 'hcl',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  sol: 'sol', pas: 'pascal', vbs: 'vb', asm: 'mips', tex: 'plaintext', bib: 'plaintext', cmake: 'plaintext',
  gitignore: 'plaintext', gitattributes: 'plaintext', dockerignore: 'plaintext', npmignore: 'plaintext', prettierrc: 'json',
  eslintrc: 'json', babelrc: 'json', lock: 'plaintext', mk: 'plaintext', makefile: 'plaintext', diff: 'plaintext', patch: 'plaintext',
  ahk: 'plaintext', au3: 'plaintext', nsi: 'plaintext', iss: 'ini', vmx: 'ini', url: 'ini', lnk: null,
};

const SPECIAL_NAMES = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'plaintext', gemfile: 'ruby', rakefile: 'ruby',
  '.env': 'ini', '.gitignore': 'plaintext', '.gitattributes': 'plaintext', '.editorconfig': 'ini', '.npmrc': 'ini',
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell', '.prettierrc': 'json',
  '.eslintrc': 'json', '.babelrc': 'json', 'cmakelists.txt': 'plaintext', 'hosts': 'plaintext', 'license': null, 'readme': null,
};

export const LANGUAGES = [
  ['plaintext', 'Plain text'], ['html', 'HTML'], ['css', 'CSS'], ['scss', 'SCSS'], ['less', 'Less'], ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'], ['json', 'JSON'], ['xml', 'XML'], ['yaml', 'YAML'], ['ini', 'INI / TOML / .env'],
  ['markdown', 'Markdown'], ['python', 'Python'], ['shell', 'Shell'], ['powershell', 'PowerShell'], ['bat', 'Batch'],
  ['sql', 'SQL'], ['java', 'Java'], ['csharp', 'C#'], ['cpp', 'C++'], ['c', 'C'], ['go', 'Go'], ['rust', 'Rust'],
  ['php', 'PHP'], ['ruby', 'Ruby'], ['lua', 'Lua'], ['kotlin', 'Kotlin'], ['swift', 'Swift'], ['dart', 'Dart'],
  ['dockerfile', 'Dockerfile'], ['graphql', 'GraphQL'], ['hcl', 'HCL / Terraform'], ['perl', 'Perl'], ['r', 'R'],
];

/** Decide which editor should open a file. */
export function detectMode(name, bytes) {
  const ext = extOf(name);
  const base = basename(name).toLowerCase();
  if (PDF_EXT.includes(ext)) return { mode: 'pdf' };
  if (ext === 'eml') return { mode: 'mail' };
  if (DOC_EXT.includes(ext)) return { mode: 'doc' };
  if (SHEET_EXT.includes(ext)) return { mode: 'sheet' };
  if (IMAGE_EXT.includes(ext)) return { mode: 'image' };
  if (VIDEO_EXT.includes(ext) || ext === 'ogg') return { mode: 'video' };
  if (base in SPECIAL_NAMES && SPECIAL_NAMES[base]) return { mode: 'code', lang: SPECIAL_NAMES[base] };
  if (TEXT_EXT.includes(ext)) return { mode: 'text' };
  if (CODE_LANG[ext]) return { mode: 'code', lang: CODE_LANG[ext] };
  if (bytes) {
    if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return { mode: 'pdf' };
    if (looksLikeText(bytes)) return { mode: 'text' };
    return { mode: 'hex' };
  }
  return { mode: ext ? 'hex' : 'text' };
}

export function langForName(name) {
  const ext = extOf(name);
  const base = basename(name).toLowerCase();
  return SPECIAL_NAMES[base] || CODE_LANG[ext] || 'plaintext';
}

export function extForLang(lang) {
  const pref = {
    plaintext: 'txt', javascript: 'js', typescript: 'ts', markdown: 'md', python: 'py', shell: 'sh', powershell: 'ps1',
    csharp: 'cs', ruby: 'rb', rust: 'rs', kotlin: 'kt', dockerfile: 'Dockerfile', yaml: 'yml', ini: 'ini',
  };
  if (pref[lang]) return pref[lang];
  const found = Object.entries(CODE_LANG).find(([, l]) => l === lang);
  return found ? found[0] : 'txt';
}

export const MODE_ICON = {
  doc: 'file-doc', pdf: 'file-pdf', text: 'file-text', code: 'file-code', sheet: 'sheet', image: 'image', hex: 'binary',
  video: 'video', form: 'form-fill', klep: 'magnet', storage: 'layers', mail: 'mail', tape: 'music', scribe: 'scan-text', paint: 'brush', diff: 'diff', ai: 'bot',
};

export const MODE_LABEL = {
  doc: 'Document', pdf: 'PDF', text: 'Text', code: 'Code', sheet: 'Sheet', image: 'Image', hex: 'Binary',
  video: 'Video', form: 'Form', klep: 'BoxVidKlep', storage: 'StoragePeek', mail: 'BoxMail', tape: 'BoxTape', scribe: 'BoxScribe', paint: 'BoxPaint', diff: 'BoxDiff',
};

export function iconForName(name, isDir) {
  if (isDir) return 'folder';
  const { mode, lang } = detectMode(name);
  if (mode === 'code') {
    if (lang === 'markdown') return 'markdown';
    if (lang === 'html') return 'globe';
    if (lang === 'json') return 'braces';
    if (['shell', 'powershell', 'bat'].includes(lang)) return 'terminal';
  }
  if (mode === 'hex') return 'file';
  return MODE_ICON[mode] || 'file';
}

/** Filters for the open dialog. */
export const OPEN_FILTERS = [
  { name: 'All supported', extensions: ['pdf', 'eml', ...DOC_EXT, 'html', 'htm', 'md', ...TEXT_EXT, ...SHEET_EXT, ...IMAGE_EXT, ...VIDEO_EXT, 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'env', 'js', 'ts', 'css', 'py', 'ps1', 'bat', 'sh'] },
  { name: 'PDF documents', extensions: ['pdf'] },
  { name: 'Email files', extensions: ['eml'] },
  { name: 'Word documents', extensions: ['docx', 'odt', 'rtf'] },
  { name: 'Text files', extensions: ['txt', 'log', 'md'] },
  { name: 'Web & config', extensions: ['html', 'htm', 'css', 'js', 'json', 'xml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'toml', 'env'] },
  { name: 'Spreadsheets', extensions: SHEET_EXT },
  { name: 'Images', extensions: IMAGE_EXT },
  { name: 'Video & audio', extensions: VIDEO_EXT },
  { name: 'All files', extensions: ['*'] },
];

export const VIDEO_FILTERS = [{ name: 'Video & audio', extensions: VIDEO_EXT.concat(['ogg']) }, { name: 'All files', extensions: ['*'] }];
