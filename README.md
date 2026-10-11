# BOX//DOCSPITTER

A self-hosted document workstation that runs entirely on your PC: a Word-style editor, a PDF editor and
form filler, a notepad, a code/config editor, spreadsheets, images, a video trimmer, a video grabber,
folder workspaces and a disk-space explorer. Everything is served from `127.0.0.1`. Your files stay on
this machine. The only optional exceptions are the ones you switch on yourself (Ask Claude, Discord status,
BoxVidKlep downloads).

## Start it

| | |
|---|---|
| **Box-DocSpitter.vbs** | Starts the app in its own window, with no console. Drag files onto it to open them. |
| **Create Shortcuts.bat** | Adds Box-DocSpitter to your Desktop and Start menu, with its icon. Run it again after moving the folder. |
| **Box-DocSpitter (with console).bat** | Same as the `.vbs`, but shows the server log. |

The app opens in its own window (built on Electron, in `node_modules/electron`), with its own taskbar icon
and no browser bars. Closing the window stops the server. `npm start` runs the server alone at
http://127.0.0.1:7717 if you'd rather use a browser tab.

## Pin it to the taskbar

Start Box-DocSpitter, right-click its button on the taskbar, and choose **Pin to taskbar**. If you pinned it
before this update, unpin the old one first, because it launches bare Electron. Settings → Windows → **Add to
Start menu & Desktop** makes shortcuts that group with the open window under one icon.

## Open files with Box-DocSpitter

Settings → **Windows** → **Choose file types**: tick PDFs, Word docs, text, config files, spreadsheets and
so on. Box-DocSpitter registers itself for them, just for your Windows account with no admin needed, so it
shows up in "Open with". Windows doesn't let apps make themselves the default, so the next step opens
Settings → Default apps on Box-DocSpitter's page, where you click **Set default**. **Remove** undoes all of
it. If you move the folder, choose the file types again to update the paths.

## Credits

- UI sound effects are from [Pixabay](https://pixabay.com), used under the Pixabay Content License. They
  aren't covered by the code's license. See `public/assets/sounds/SOUNDS-LICENSE.txt`.
- Built on pdf.js, pdf-lib, Monaco, SheetJS, docx, JSZip, marked, ffmpeg.wasm, Electron, nodemailer,
  ImapFlow, mailparser and the Anthropic SDK (installed by npm under their own licenses). It also uses
  yt-dlp and ffmpeg if you install them.

## Getting it from GitHub

The repo holds only the source (about 2 MB). The libraries and the Electron runtime come from npm:

1. Install **Node.js 18+** (`winget install OpenJS.NodeJS.LTS`) and download or clone this repo.
2. Double-click `Box-DocSpitter.vbs`. On first run it does `npm install` (a few hundred MB), then opens the
   app. Or run `npm install` yourself in the folder.
3. Optional: `winget install yt-dlp` and `winget install Gyan.FFmpeg` for BoxVidKlep, BoxTape and faster video
   exports.

Your personal data (`data/`) and the dumps are never part of the repo. They're listed in `.gitignore`.

## Portable: copy it to another PC

The folder is self-contained. Nothing needs installing, not even Node.js, because Electron brings its own.
1. Copy the whole `Box-DocSpitter` folder, including `node_modules`, anywhere: another PC, a USB stick or `C:\Apps`.
   Keep the path reasonably short. Windows can't start programs more than about 260 characters deep.
2. On the new PC, double-click `Create Shortcuts.bat`, or just `Box-DocSpitter.vbs`.

Everything the app stores lives in `data\`, including Electron's cache. Nothing goes into `%APPDATA%`.
Before handing a copy to someone else, use **Settings → Reset → Reset to clean state**. It erases settings,
recent files and spaces, drafts, version history, your API key, Discord lines, form-fill info and caches, and
optionally the image dump. Then it restarts the app as a fresh copy. Your own files elsewhere are never touched.
Needs Windows 10 or 11 (64-bit). PDF export uses Edge if it's installed, otherwise the app window's own
renderer. If `node_modules` wasn't copied, the launcher offers to download it, which needs Node.js and internet
once.

## Modes

**Documents** (`.docx`, `.odt`, `.rtf`, `.html`, `.md`, `.txt`)
Paper layout with page markers, styles (Title, Headings, Quote, Code), fonts, sizes, colors and highlight.
Also: lists, checklists, tables (right-click for rows and columns), images (resize, wrap, align), links,
page breaks, table of contents, outline, find & replace, word count and page setup. Saves `.docx`, HTML,
Markdown, RTF or text, and exports PDF. Crash-recovery drafts are kept automatically.
**Pages**: the toolbar buttons next to Print add a blank page (Ctrl+Alt+Enter) or delete the current one
(Ctrl+Alt+Backspace). Each page also has its own add and delete buttons in the right margin, and there's an
**add page** button under the last page. **Pageless** turns the document into one continuous sheet as wide as
the window. PDF export and printing still use pages. **Export as image** saves the current page, every page
as its own file, or the whole document as one long image, as PNG, JPG or WebP at 1×, 2× or 3× sharpness. It can
also copy the image to the clipboard or send it to the image dump.
**Image dump** and **doc dump**: two tabs at the bottom of the editor, backed by the `image-dump/` and
`doc-dump/` folders. Click a picture to insert it, or click a document (PDF, Word, spreadsheet, text…) to open it in a new tab. Right-click copies:
a picture goes to the clipboard as an image, and a document as a file you can paste into Explorer or Discord.
Shift+right-click shows every option. Drag items into the page, or out of the app as real files. Drop or paste
files in to keep them, and use "Save this doc here" to put the open document in the doc dump as a PDF.

**PDF** View, highlight, draw, add text, edit existing text, add shapes, arrows, whiteout, images and
signatures. Fill form fields. Rotate, reorder (drag thumbnails), insert, duplicate, delete and extract
pages, or merge in other PDFs and images. Saves a real PDF, or exports a flattened copy or PNGs.

**Fill a form** A PDF mode built for government-style forms. Forms locked against editing (common on
government sites) are opened as an unlocked copy automatically, so their fields work. It has a field list with progress, "next
empty field", one-click **Autofill** from *My info* (stored only on this PC), and stamps: ✓ ✗ date,
initials and signature. Scanned forms without fields work too: click and type on the lines. **Finalize**
saves a flattened completed copy.

**Text** Notepad-style editing. Wrap, line numbers, fonts, case tools, sort and dedupe lines, encodings
(UTF-8/16, Windows-1252) and CRLF/LF are preserved.

**Code & config** Monaco (VS Code's editor) for JSON, YAML, INI/TOML/.env, XML, HTML, CSS, JS/TS,
Python, PowerShell and more. Includes live preview for HTML and Markdown, formatting, and JSON
minify/sort.

**Spreadsheets** (`.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv`) Formulas (SUM, IF, VLOOKUP, SUMIF, …), sheets,
sort, insert/delete rows and columns, column resize, and live sum/avg of the selection.

**Images** Crop, rotate, flip, resize and adjust colors. Save as PNG, JPG or WebP, or export as PDF.

**Video trimmer** Mark in/out on a filmstrip timeline, preview the loop, and export as an instant
lossless copy, MP4, WebM, GIF, MP3 or WAV. Grab single frames as PNGs, or send them to the image dump.
It runs with the built-in ffmpeg.wasm. If you install real ffmpeg (`winget install Gyan.FFmpeg`),
big files export much faster.

**BoxVidKlep** Paste a web page or video link and it finds the videos on that page. You pick which
ones to download, rename them, or send them straight to the trimmer. Direct video files work out of
the box. YouTube and most social sites need **yt-dlp** (`winget install yt-dlp`), which BoxVidKlep uses
automatically once it's installed. DRM-protected streams are skipped. Only download what you have the
right to keep.

**BoxSpaces** Open a folder like an IDE. You get a file tree with git status colors, search across all
files, Ctrl+E quick-open, and new, rename, duplicate and delete. Delete sends to the Recycle Bin.

**StoragePeek** Usage bars for every drive. Scan a drive or folder to get a clickable treemap of what's
using the space, the biggest files, and a breakdown by type and extension. The scanner is a small native
helper (`tools/bds-scan.cs`) compiled on first use by the C# compiler built into Windows. It reads whole
folders at once on every CPU core and counts real on-disk size: a full 1.5-million-file drive takes
seconds. The treemap fills in live while it runs. Space it can't open shows as a striped tile.
**Rescan as admin** asks Windows for permission, then also reads protected folders (restore points,
other users, WindowsApps) and counts the NTFS file table.

**BoxMail** Gmail inside Box-DocSpitter, with as many accounts as you like. The inbox is split into
Gmail's tabs (Primary, Updates, Promotions, Social, Forums), plus Starred, Sent, Drafts, All mail, Spam and
Trash, and Gmail search works (`from:`, `has:attachment`, ...). Compose, reply and forward, with
attachments in one click from the image dump, the doc dump, any open document or your disk. Drop files on
the composer to attach them. **✦ Claude** drafts emails from a note, polishes or shortens them, fixes
grammar, summarizes emails, lists action items and drafts replies. Nothing is sent until you press Send.
Attachments you receive can go straight into the dumps. Setup: Settings → Email → **Add Gmail account**,
with a Google *app password* from myaccount.google.com/apppasswords (needs 2-Step Verification). The password
is stored only in `data/secrets.json`. Mailboxes are opened read-only, so browsing never marks mail as read.
Emails display with no scripts and remote images (tracking pixels) blocked until you load them. Saved
`.eml` files open in BoxMail too, no account needed.

**BoxTape** Paste a YouTube playlist (or an album, or a single video) and pick the tracks. They're saved as
MP3s, with title, artist and cover art, into `audio-dump/` for the ♪ player, one at a time with
per-track progress. A track that fails is skipped and listed. BoxVidKlep also has an **MP3** button on every
video, and a bulk **→ MP3** button, for the same thing. Needs yt-dlp and ffmpeg. Only download music you
have the right to keep.

**Binary files** A fast hex viewer that identifies the file type.

## Side tabs (right edge)

- **Ω chars**: every Alt code (Alt+1–255 and Alt+0128–0255) plus Unicode symbol sets: arrows, math,
  currency, Greek, box drawing, emoji and more. Searchable by name or code. **Click** adds the character
  to your document. **Right-click** copies it.
- **✦ claude**: optional assistant. Paste your Anthropic API key once. It's saved to
  `data/secrets.json` and never shown again. Then summarize, rewrite, fix grammar, translate or explain
  code, using your selection or the whole file. Text goes to Anthropic only when you press a button.
  Default model: Claude Opus 5.5.

- **✂ clip**: two sub-tabs.
  - **History** keeps what you copy inside Box-DocSpitter: text (Ctrl+C, Copy buttons, characters, paths),
    pictures copied from the image dump, and files copied from the dumps.
  - **Snippets** are texts you save and reuse (addresses, sign-offs, stock replies, form answers).
  - Click to put an item into what you're working on, right-click to copy it again, and Shift+right-click
    for pin, save as snippet, edit, reorder and delete. Everything is stored in `data/clips.json` and erased
    by the factory reset.

## Other handy bits

- **Ctrl+Shift+P** command palette · **Ctrl+E** quick open · **F1** all shortcuts · **F11** focus mode
- **Version history**: every save keeps the previous version (File → Version history).
- **Discord status** (Settings → Discord): off by default. Choose automatic lines ("editing a .pdf",
  "changing a config") or write your own. File names are never sent.
- Light and dark themes. Windows open/save dialogs, or the built-in file browser.
- **Sounds** for hover, clicks, typing, opening and closing documents (`public/assets/sounds/`). Click the
  speaker button to mute them. Hover it for a volume slider. Typing and hover sounds can be switched off
  in Settings → Appearance.
- **♪ Music player**: plays everything in the `audio-dump/` folder (mp3, m4a, wav, flac, ogg). It has
  play/pause, skip, shuffle, loop (all or one song), seek and volume, and music keeps playing while you
  work. Media keys work too. Drop songs onto the player or use **+** to add them. **Mixer** is a 10-band
  equalizer (±18 dB) with low cut and high cut, a live response curve, and presets (Tinny/phone, AM radio,
  Muffled, Underwater, Lo-fi, Bass boost, Vocal…).

## Where things live

| Folder | What |
|---|---|
| `data/settings.json` | your preferences, Discord lines, My info |
| `data/secrets.json` | your Anthropic API key, if you add one |
| `data/backups/` | previous versions of files you saved |
| `data/drafts/` | crash-recovery copies of unsaved work |
| `data/bin/` | the compiled StoragePeek scanner (rebuilt automatically if deleted) |
| `doc-dump/` | the doc dump (removed files go to `doc-dump/.removed`) |
| `audio-dump/` | songs for the ♪ player (removed songs go to `audio-dump/.removed`) |
| `image-dump/` | the image dump (removed images go to `image-dump/.removed`) |

## Under the hood

Node's built-in HTTP server with no frameworks. The page gets a random token per launch, and the server
only answers requests from `127.0.0.1` with that token. Libraries are served from `node_modules`:
pdf.js, pdf-lib, Monaco, SheetJS, docx, JSZip, marked, ffmpeg.wasm and the Anthropic SDK.
