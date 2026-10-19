// StoragePeek: drive usage + folder size scans.

'use strict';

const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// folder names: Windows ignores case, Linux doesn't (Photos and photos are two folders there)
const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;

module.exports = function createStorage({
  APP_NAME, DATA, IS_WIN, PUBLIC, ROOT, listDrives, newJob, readJSONBody, requirePath, runCapture, startJob,
}) {
  let volumeCache = { at: 0, map: {} };
  async function volumeInfo() {
    if (!IS_WIN) return {};
    if (Date.now() - volumeCache.at < 60000) return volumeCache.map;
    try {
      const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, VolumeName, DriveType, FileSystem | ConvertTo-Json -Compress'], 15000);
      const arr = [].concat(JSON.parse(out || '[]'));
      const map = {};
      for (const v of arr) map[String(v.DeviceID).toUpperCase()] = { label: v.VolumeName || '', type: v.DriveType, fs: v.FileSystem || '' };
      volumeCache = { at: Date.now(), map };
    } catch { /* ignore */ }
    return volumeCache.map;
  }

  async function drives() {
    const vols = await volumeInfo();
    const out = [];
    for (const d of listDrives()) {
      try {
        const s = await fsp.statfs(d);
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        const v = vols[d.slice(0, 2).toUpperCase()] || {};
        out.push({ path: d, total, free, used: total - free, label: v.label || '', kind: { 2: 'removable', 3: 'local', 4: 'network', 5: 'optical' }[v.type] || 'drive', fs: v.fs || '' });
      } catch { /* not ready (e.g. empty card reader) */ }
    }
    return out;
  }

  const CATEGORY = [
    ['video', /\.(mp4|mkv|mov|avi|wmv|webm|m4v|m4s|flv|ts|m2ts|mts|3gp|vob)$/i],
    ['image', /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|raw|cr2|nef|arw|dng|psd|svg|ico)$/i],
    ['audio', /\.(mp3|wav|flac|m4a|aac|ogg|opus|wma|aiff?)$/i],
    ['archive', /\.(zip|7z|rar|tar|gz|bz2|xz|iso|img|cab|msi|vhdx?|vmdk|dmg)$/i],
    ['document', /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|rtf|csv|epub)$/i],
    ['code', /\.(js|ts|py|java|cs|cpp|c|h|go|rs|rb|php|json|xml|yml|yaml|html|css|lua|sh|ps1|sql)$/i],
    ['game', /\.(pak|p4k|vpk|bsa|ba2|esm|esp|esl|forge|ucas|utoc|upk|uasset|umap|wad|pck|big|gcf|ncm|rpf|vfs|arc|cpk|dsar|xxx|bnk|wem|sii|scs|acf|ress|resource|assets|ztr|tex|toc|sb|cas|cat)$/i],
    ['app', /\.(exe|dll|sys|so|dylib|bin|dat|bundle|asar|node|jar|class|apk|appx|msix|lib|pdb|obj|cache|db|sqlite|ldb|blob|msp)$/i],
  ];
  const categoryOf = (name) => (CATEGORY.find(([, re]) => re.test(name)) || ['other'])[0];

  const scans = new Map();

  /**
   * A scan result that fills in while the scan runs. Each folder's own size is pushed up to its ancestors as
   * soon as it is counted, so a view of any folder is correct for whatever has been seen so far.
   */
  class ScanTree {
    constructor(root) {
      this.root = root;
      this.nodes = [];
      this.bigFiles = [];
      this.minBig = 0;
      this.byType = {};
      this.byExt = [];
      this.admin = false;
      this.mft = 0;
      this.denied = 0;
      this.add(0, -1, root);
    }
    add(id, parentId, name) {
      const parent = parentId >= 0 ? this.nodes[parentId] : null;
      const n = { id, name, parent, own: 0, logical: 0, count: 0, size: 0, total: 0, kids: new Map(), files: [], denied: false };
      this.nodes[id] = n;
      if (parent) parent.kids.set(fold(name), n);
      return n;
    }
    counted(id, alloc, logical, count, denied) {
      const n = this.nodes[id];
      if (!n) return;
      n.own = alloc;
      n.logical = logical;
      n.count = count;
      n.denied = !!denied;
      if (denied) this.denied++;
      for (let p = n; p; p = p.parent) { p.size += alloc; p.total += count; }
    }
    file(id, size, name) {
      const n = this.nodes[id];
      if (!n) return;
      n.files.push({ name, size });
      if (n.files.length > 24) { n.files.sort((a, b) => b.size - a.size); n.files.length = 16; }
      if (this.bigFiles.length < 200 || size > this.minBig) {
        this.bigFiles.push({ node: n, name, size });
        if (this.bigFiles.length > 260) {
          this.bigFiles.sort((a, b) => b.size - a.size);
          this.bigFiles.length = 200;
          this.minBig = this.bigFiles[199].size;
        }
      }
    }
    pathOf(n) {
      const parts = [];
      for (let p = n; p.parent; p = p.parent) parts.push(p.name);
      return path.join(this.root, ...parts.reverse());
    }
  }

  const SCAN_SRC = path.join(ROOT, 'tools', 'bds-scan.cs');
  let scanToolPromise = null;

  /** Compiles tools/bds-scan.cs with the C# compiler built into Windows (once per source version). */
  function scanTool() {
    if (!IS_WIN) return Promise.resolve(null);
    if (!scanToolPromise) {
      scanToolPromise = (async () => {
        const src = await fsp.readFile(SCAN_SRC);
        const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 10);
        const dir = path.join(DATA, 'bin');
        const exe = path.join(dir, `bds-scan-${hash}.exe`);
        if (fs.existsSync(exe)) return exe;
        const windir = process.env.WINDIR || 'C:\\Windows';
        const csc = [
          path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
          path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
        ].find((p) => fs.existsSync(p));
        if (!csc) return null;
        await fsp.mkdir(dir, { recursive: true });
        for (const old of await fsp.readdir(dir).catch(() => [])) {
          if (/^bds-scan-.*\.exe$/.test(old)) await fsp.unlink(path.join(dir, old)).catch(() => {});
        }
        await new Promise((resolve, reject) => execFile(csc, ['/nologo', '/optimize+', `/out:${exe}`, SCAN_SRC], { windowsHide: true, timeout: 60000 },
          (err, stdout) => (err ? reject(new Error('Scanner compile failed: ' + (stdout || err.message))) : resolve())));
        return exe;
      })().catch((e) => { console.error(`[${APP_NAME}] ${e.message}`); scanToolPromise = null; return null; });
    }
    return scanToolPromise;
  }

  /**
   * Keeps Box-Deckspitter.exe (the launcher) in step with tools/launcher.cs: the source's hash is stamped into
   * the .exe, and it's rebuilt only when that stamp is missing (no .exe, or an update changed the source).
   */
  const LAUNCHER_EXE = 'Box-Deckspitter.exe';
  async function buildLauncher() {
    if (!IS_WIN) return;
    const src = path.join(ROOT, 'tools', 'launcher.cs');
    const exe = path.join(ROOT, LAUNCHER_EXE);
    // Line endings ignored: git may check the source out with either.
    const hash = crypto.createHash('sha1').update((await fsp.readFile(src, 'utf8')).replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);
    const stamp = `bds-launcher:${hash}`;
    if ((await fsp.readFile(exe).catch(() => Buffer.alloc(0))).includes(stamp)) return;
    const windir = process.env.WINDIR || 'C:\\Windows';
    const csc = [
      path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ].find((p) => fs.existsSync(p));
    if (!csc) return;
    const dir = path.join(DATA, 'bin');
    await fsp.mkdir(dir, { recursive: true });
    const stampSrc = path.join(dir, 'launcher-stamp.cs');
    const out = path.join(dir, LAUNCHER_EXE);
    await fsp.writeFile(stampSrc, `[assembly: System.Reflection.AssemblyDescription("${stamp}")]\n`);
    await new Promise((resolve, reject) => execFile(csc, ['/nologo', '/optimize+', '/target:winexe', `/out:${out}`,
      `/win32icon:${path.join(PUBLIC, 'assets', 'icon-lavender.ico')}`, src, stampSrc], { windowsHide: true, timeout: 60000 },
    (err, stdout) => (err ? reject(new Error('Launcher compile failed: ' + (stdout || err.message))) : resolve())));
    await fsp.rename(out, exe); // fails harmlessly if the .exe is still running; tried again next start
    console.log(`[${APP_NAME}] rebuilt ${LAUNCHER_EXE}`);
  }

  function applyScanLine(tree, job, line) {
    const f = line.split('\t');
    switch (f[0]) {
      case 'D': {
        const n = tree.add(Number(f[1]), Number(f[2]), f[3]);
        if (n.parent) job.current = tree.pathOf(n);
        break;
      }
      case 'S':
        tree.counted(Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4]), f[5] === '1');
        job.dirs++;
        job.files += Number(f[4]);
        job.bytes += Number(f[2]);
        if (job.total) job.progress = Math.min(0.99, job.bytes / job.total);
        break;
      case 'F': tree.file(Number(f[1]), Number(f[2]), f[3]); break;
      case 'T': {
        const cat = categoryOf('x.' + f[1]);
        tree.byType[cat] = (tree.byType[cat] || 0) + Number(f[2]);
        tree.byExt.push([f[1], Number(f[2])]);
        break;
      }
      case 'A': tree.admin = f[1] === '1'; job.admin = tree.admin; break;
      case 'M': tree.mft = Number(f[1]); break;
      case 'E': job.elapsed = Number(f[2]); break;
      default: break;
    }
  }

  /** Runs the native scanner. Admin scans go through a UAC prompt and report through a file. */
  async function nativeScan(job, tree, exe, elevated) {
    let cancelled = false;
    let rest = '';
    const feed = (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const l of lines) if (l) applyScanLine(tree, job, l.replace(/\r$/, ''));
    };
    if (!elevated) {
      const child = spawn(exe, [tree.root], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      job.cancel = () => { cancelled = true; child.kill(); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', feed);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      if (rest) feed('\n');
      if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      if (code !== 0) throw new Error(`Scanner stopped unexpectedly (code ${code})`);
      return;
    }
    const out = path.join(DATA, 'bin', `scan-${job.id}.txt`);
    const q = (s) => s.replace(/'/g, "''");
    // A trailing backslash would escape the closing quote of the argument (C:\" ), so double it.
    const rootArg = '"' + tree.root.replace(/\\$/, '\\\\') + '"';
    const ps = `$p = Start-Process -FilePath '${q(exe)}' -ArgumentList @('${q(rootArg)}','--out','"${q(out)}"') -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    job.cancel = () => { cancelled = true; fs.writeFile(out + '.cancel', '', () => {}); };
    job.current = 'waiting for you to approve the admin prompt…';
    let exited = false;
    let exitCode = null;
    child.on('close', (c) => { exited = true; exitCode = c; });
    let pos = 0;
    const decoder = new StringDecoder('utf8');
    const pump = async () => {
      const fh = await fsp.open(out, 'r').catch(() => null);
      if (!fh) return;
      try {
        const buf = Buffer.alloc(1 << 20);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          pos += bytesRead;
          feed(decoder.write(buf.subarray(0, bytesRead)));
        }
      } finally { await fh.close(); }
    };
    while (!exited) { await new Promise((r) => setTimeout(r, 250)); await pump(); }
    await pump();
    if (rest) feed('\n');
    await fsp.unlink(out).catch(() => {});
    await fsp.unlink(out + '.cancel').catch(() => {});
    if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    if (!pos) throw new Error('The admin scan didn’t run (was the prompt declined?)');
    if (!job.elapsed) throw new Error(`Scanner stopped unexpectedly (code ${exitCode})`);
  }

  /** Portable fallback: parallel readdir + lstat in Node (slower; used when the native scanner is unavailable). */
  async function jsScan(job, tree) {
    let cancelled = false;
    job.cancel = () => { cancelled = true; };
    let nextId = 0;
    const queue = [[tree.root, 0]];
    let active = 0;
    const one = async (dir, id) => {
      job.current = dir;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { tree.counted(id, 0, 0, 0, true); job.dirs++; return; }
      let own = 0;
      let count = 0;
      const files = [];
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) { const cid = ++nextId; tree.add(cid, id, e.name); queue.push([path.join(dir, e.name), cid]); } else if (e.isFile()) files.push(e.name);
      }
      for (let i = 0; i < files.length && !cancelled; i += 64) {
        const stats = await Promise.all(files.slice(i, i + 64).map((n) => fsp.lstat(path.join(dir, n)).then((s) => [n, s.size], () => null)));
        for (const s of stats) {
          if (!s) continue;
          own += s[1];
          count++;
          const cat = categoryOf(s[0]);
          tree.byType[cat] = (tree.byType[cat] || 0) + s[1];
          tree.extTotals[path.extname(s[0]).slice(1).toLowerCase()] = (tree.extTotals[path.extname(s[0]).slice(1).toLowerCase()] || 0) + s[1];
          if (s[1] >= 1024 * 1024) tree.file(id, s[1], s[0]);
        }
      }
      tree.counted(id, own, own, count, false);
      job.dirs++;
      job.files += count;
      job.bytes += own;
      if (job.total) job.progress = Math.min(0.99, job.bytes / job.total);
    };
    await new Promise((resolve) => {
      const pump = () => {
        if (cancelled && !active) return resolve();
        while (!cancelled && active < 32 && queue.length) {
          const [dir, id] = queue.pop();
          active++;
          one(dir, id).catch(() => {}).finally(() => { active--; if (!queue.length && !active) resolve(); else pump(); });
        }
        if (!queue.length && !active) resolve();
      };
      pump();
    });
    if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  }

  async function scanFolder(job, root, { elevated = false } = {}) {
    const tree = new ScanTree(root);
    const isDrive = path.parse(root).root.toLowerCase() === root.toLowerCase();
    const st = isDrive ? await fsp.statfs(root).catch(() => null) : null;
    job.total = st ? (st.blocks - st.bavail) * st.bsize : null;
    job.files = 0;
    job.dirs = 0;
    scans.set(job.id, { root, tree, job, at: Date.now(), driveUsed: job.total });
    for (const [id, s] of scans) if (id !== job.id && Date.now() - s.at > 3600_000) scans.delete(id); // keep memory in check
    const exe = await scanTool();
    job.engine = exe ? 'native' : 'node';
    if (exe) {
      try {
        await nativeScan(job, tree, exe, elevated);
        return;
      } catch (e) {
        // If antivirus blocked or removed the compiled scanner, fall back to the portable scanner.
        if (e.name === 'AbortError' || elevated || job.dirs > 0) throw e;
        console.error(`[${APP_NAME}] native scanner unavailable (${e.message}); using the portable scanner`);
        scanToolPromise = null;
        job.engine = 'node';
        return scanFolderJs(job, root);
      }
    }
    if (elevated) throw new Error('Admin scans need Windows');
    await runJsScan(job, tree);
  }

  async function scanFolderJs(job, root) {
    const tree = new ScanTree(root);
    const prev = scans.get(job.id);
    scans.set(job.id, { ...prev, tree });
    Object.assign(job, { files: 0, dirs: 0, bytes: 0 });
    await runJsScan(job, tree);
  }

  async function runJsScan(job, tree) {
    tree.extTotals = {};
    await jsScan(job, tree);
    tree.byExt = Object.entries(tree.extTotals);
  }

  function scanView(scan, p) {
    const { tree, job } = scan;
    const top = tree.nodes[0];
    let node = top;
    let cur = scan.root;
    if (p && fold(p) !== fold(scan.root)) {
      const rel = path.relative(scan.root, p);
      for (const part of rel.split(path.sep).filter(Boolean)) {
        node = node.kids.get(fold(part));
        if (!node) throw Object.assign(new Error('Folder not in this scan'), { status: 404 });
        cur = path.join(cur, node.name);
      }
    }
    const kids = [...node.kids.values()].sort((a, b) => b.size - a.size).slice(0, 300)
      .map((k) => ({ name: k.name, path: path.join(cur, k.name), size: k.size, count: k.total, isDir: true, denied: k.denied }));
    const files = [...node.files].sort((a, b) => b.size - a.size).slice(0, 16)
      .map((f) => ({ name: f.name, path: path.join(cur, f.name), size: f.size, isDir: false, cat: categoryOf(f.name) }));
    const shownFiles = files.reduce((a, f) => a + f.size, 0);
    const running = job.status === 'running';
    // At a drive root, show the space the scan couldn't see, so the map adds up to what Windows reports as used.
    const extra = [];
    let size = node.size;
    if (node === top && scan.driveUsed) {
      if (tree.mft) { extra.push({ name: 'NTFS file table ($MFT)', size: tree.mft, cat: 'system' }); size += tree.mft; }
      const gap = scan.driveUsed - size;
      if (gap > scan.driveUsed * 0.002) {
        extra.push(running
          ? { name: 'not scanned yet', size: gap, cat: 'pending' }
          : { name: tree.admin ? 'System & reserved (shadow copies, metadata)' : IS_WIN ? 'Hidden / protected — rescan as admin' : 'Hidden / no permission to read', size: gap, cat: 'hidden' });
        size += gap;
      }
    }
    return {
      root: scan.root, path: cur, size, scanned: node.size, count: node.total, kids, files, extra,
      looseFiles: Math.max(0, node.own - shownFiles), running, admin: tree.admin, denied: tree.denied, engine: job.engine,
      elapsed: job.elapsed || Date.now() - job.started, isDrive: !!scan.driveUsed,
      bigFiles: [...tree.bigFiles].sort((a, b) => b.size - a.size).slice(0, 200).map((b) => ({ path: path.join(tree.pathOf(b.node), b.name), size: b.size })),
      byType: tree.byType,
      byExt: [...tree.byExt].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([ext, size]) => ({ ext, size, cat: categoryOf('x.' + ext) })),
    };
  }

  const routes = {
    'GET /api/drives': async () => drives(),
    'POST /api/storage/scan': async (req) => {
      const { path: p, elevated } = await readJSONBody(req);
      const root = requirePath(p);
      const job = newJob('scan ' + root);
      job.bytes = 0;
      job.files = 0;
      return startJob(job, () => scanFolder(job, root, { elevated: !!elevated }));
    },
    'GET /api/storage/view': async (req, q) => {
      const scan = scans.get(q.get('id'));
      if (!scan) throw Object.assign(new Error('Scan expired — run it again'), { status: 404 });
      return scanView(scan, q.get('path'));
    },
  };

  return { routes, drives, buildLauncher };
};
