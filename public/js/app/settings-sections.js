// Box-Deckspitter app shell, Settings sections: sound, updates, Windows, file types, mail, AI assistant, Discord.
// Methods of App (app.js mixes this class into it).

import { $, h, clear, extOf, formatBytes, debounce } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { modal, confirmDialog, promptDialog, toast, errorToast } from '../core/ui.js';
import { pickOpen } from '../core/files.js';
import { PROVIDERS } from '../core/ai-providers.js';

export class SettingsSectionsPart {
  /** Settings → Sounds: preview, swap or reset each UI sound. */
  soundSettings() {
    const list = h('div', { class: 'sound-list' });
    const render = async () => {
      const { SOUND_LABELS } = await import('../core/sounds.js');
      let custom = {};
      try { custom = await api.customSounds(); } catch { /* old server */ }
      clear(list);
      for (const [name, label] of Object.entries(SOUND_LABELS)) {
        const mine = custom[name];
        list.append(h('div', { class: 'sound-row' },
          h('button', { class: 'icon-btn', 'data-tip': 'Play it', onclick: () => this.sounds.preview(name) }, icon('play', 'sm')),
          h('div', { class: 'sound-name' }, h('span', {}, label), h('span', { class: 'faint mono' }, mine ? `your file · ${mine.file.replace(/^[^.]+/, name)}` : 'default')),
          h('button', { class: 'btn sm', onclick: () => pick(name) }, 'Change…'),
          mine ? h('button', { class: 'btn sm ghost', onclick: async () => { await api.resetSound(name).catch(errorToast); await this.sounds.reload(name, false); render(); } }, 'Default') : null));
      }
      if (Object.keys(custom).length) list.append(h('button', { class: 'btn sm ghost sound-reset-all', onclick: async () => {
        if (!(await confirmDialog('Back to the default sounds?', `All the UI sounds go back to the ones Box-Deckspitter came with. Your own files are deleted from data${BDS.sep}sounds.`, { okLabel: 'Use the defaults' }))) return;
        await api.resetSound(null).catch(errorToast);
        for (const n of Object.keys(custom)) await this.sounds.reload(n, false);
        render();
      } }, icon('undo', 'sm'), 'Reset all to default'));
    };
    const pick = async (name) => {
      const paths = await pickOpen({ title: 'Choose a sound', filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'webm'] }] });
      if (!paths?.length) return;
      try {
        const { bytes } = await api.read(paths[0]);
        if (bytes.length > 8 * 1024 * 1024) throw new Error('That file is too big for a UI sound (8 MB max). Short clips work best.');
        await api.setCustomSound(name, extOf(paths[0]), bytes);
        await this.sounds.reload(name, true);
        render();
      } catch (e) { errorToast(e, 'Couldn’t use that sound'); }
    };
    render();
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Sounds'),
      h('div', { class: 'dim', style: { fontSize: '12px' } }, 'Swap any UI sound for your own clip. Short sounds (under a second) feel best.'), list);
  }

  /** Settings → Audio devices: the microphone and speakers BoxComms's radio uses, with a level meter and a test sound. */
  audioDeviceSettings() {
    const inSel = h('select', {}), outSel = h('select', {});
    const meter = h('div', { class: 'comms-meter' }, h('i'));
    const note = h('div', { class: 'faint', style: { fontSize: '11px' } });
    let test = null;
    const fill = async () => {
      let devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const ins = () => devs.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
      const outs = () => devs.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications');
      const opts = (list, word) => [h('option', { value: 'default' }, 'System default'), ...list.filter((d) => d.deviceId !== 'default').map((d, i) => h('option', { value: d.deviceId }, d.label || `${word} ${i + 1}`))];
      clear(inSel).append(...opts(ins(), 'Microphone'));
      clear(outSel).append(...opts(outs(), 'Speakers'));
      inSel.value = ins().some((d) => d.deviceId === this.settings.audioIn) ? this.settings.audioIn : 'default';
      outSel.value = outs().some((d) => d.deviceId === this.settings.audioOut) ? this.settings.audioOut : 'default';
      note.textContent = ins().some((d) => d.label) ? '' : 'Device names show once Box-Deckspitter may use the microphone: click Test mic.';
    };
    inSel.addEventListener('change', () => { this.saveSettings({ audioIn: inSel.value }); this.comms?.reopenMic(); if (test) startTest(); });
    outSel.addEventListener('change', () => { this.saveSettings({ audioOut: outSel.value }); this.comms?.setOutput(outSel.value); });
    const stopTest = () => { if (!test) return; clearInterval(test.timer); test.stream.getTracks().forEach((t) => t.stop()); test.ctx.close(); test = null; meter.firstChild.style.width = '0'; micBtn.lastChild.textContent = 'Test mic'; };
    const startTest = async () => {
      stopTest();
      try {
        const dev = this.settings.audioIn;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: dev && dev !== 'default' ? { deviceId: { exact: dev } } : true });
        const ctx = new AudioContext(), an = ctx.createAnalyser(), data = new Float32Array(an.fftSize);
        ctx.createMediaStreamSource(stream).connect(an);
        test = { stream, ctx, timer: setInterval(() => {
          if (!meter.isConnected) return stopTest();
          an.getFloatTimeDomainData(data);
          meter.firstChild.style.width = `${Math.min(100, Math.round(Math.sqrt(data.reduce((m, v) => Math.max(m, Math.abs(v)), 0)) * 100))}%`;
        }, 60) };
        micBtn.lastChild.textContent = 'Stop';
        fill();
      } catch (e) { errorToast(e, 'Couldn’t open the microphone'); }
    };
    const micBtn = h('button', { class: 'btn sm', onclick: () => (test ? stopTest() : startTest()) }, icon('mic', 'sm'), h('span', {}, 'Test mic'));
    const speakerBtn = h('button', { class: 'btn sm', onclick: async () => {
      const ctx = new AudioContext();
      try { if (ctx.setSinkId && outSel.value !== 'default') await ctx.setSinkId(outSel.value); } catch { /* the default then */ }
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 660; g.gain.value = 0.15;
      o.connect(g).connect(ctx.destination);
      o.start(); o.frequency.setValueAtTime(880, ctx.currentTime + 0.15); o.stop(ctx.currentTime + 0.3);
      o.onended = () => ctx.close();
    } }, icon('volume', 'sm'), 'Test speakers');
    navigator.mediaDevices.addEventListener?.('devicechange', () => { if (inSel.isConnected) fill(); });
    fill();
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Audio devices'),
      h('div', { class: 'dim', style: { fontSize: '12px' } }, 'For BoxComms’s radio.'),
      h('span', { class: 'dim' }, 'Input (microphone)'), inSel,
      h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } }, micBtn, meter),
      h('span', { class: 'dim' }, 'Output (speakers or headphones)'), outSel,
      h('div', { class: 'row' }, speakerBtn),
      note);
  }

  /** Settings → BoxComms: on or off, your name, where files you accept go. */
  commsSettings() {
    const box = h('div', { class: 'settings-group' });
    const render = () => {
      const st = this.comms?.state;
      const c = this.settings.comms || {};
      const on = h('input', { type: 'checkbox' });
      on.checked = !!st?.on;
      on.addEventListener('change', async () => { try { await (on.checked ? this.comms.start() : this.comms.stop()); } catch (e) { errorToast(e); } render(); });
      const name = h('input', { type: 'text', maxlength: '40', value: c.name || st?.me?.name || '', placeholder: 'Your name on the network' });
      name.addEventListener('change', () => { this.saveSettings({ comms: { ...(this.settings.comms || {}), name: name.value.trim() } }); if (this.comms?.state.on) this.comms.start().catch(errorToast); });
      clear(box).append(h('h4', {}, 'BoxComms'),
        h('label', { class: 'check' }, on, 'On the local network while the app is open'),
        h('span', { class: 'dim' }, 'Your name'), name,
        h('div', { class: 'faint', style: { fontSize: '11px' } }, `Files you accept go to ${st?.me?.folder || 'Downloads' + BDS.sep + 'BoxComms'} (change it in BoxComms).`),
        h('button', { class: 'btn sm', onclick: () => this.newDocument('comms') }, icon('radio', 'sm'), 'Open BoxComms'));
    };
    render();
    return box;
  }

  updateSettings() {
    const H = { 'X-BDS-Token': api.token };
    const call = (method, url, body) => fetch(url, { method, headers: { ...H, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
    const line = h('span', { class: 'dim mono', style: { fontSize: '11px' } }, `v${window.BDS?.version}`);
    const note = h('div', { class: 'dim', style: { fontSize: '12px' } });
    const out = h('div', { class: 'update-out' });
    const actions = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const tokenRow = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    let st = null;

    const restartBtn = (v) => h('button', { class: 'btn sm primary', onclick: async () => {
      if (this.tabs.some((t) => t.dirty) && !(await confirmDialog('Restart now?', 'Some tabs have unsaved changes. Save them first, or they’ll be lost when the app restarts.', { okLabel: 'Restart anyway', danger: true }))) return;
      try { await call('POST', '/api/update/apply'); toast(`Restarting to install ${v}…`, { timeout: 5000 }); } catch (e) { errorToast(e); }
    } }, icon('refresh', 'sm'), `Restart & install ${v}`);

    const download = async (info) => {
      clear(actions).append(h('span', { class: 'dim' }, 'Downloading…'));
      try {
        const { id } = await call('POST', '/api/update/download');
        for (;;) {
          await new Promise((r) => setTimeout(r, 400));
          const j = await fetch(`/api/job?id=${id}`, { headers: H }).then((r) => r.json());
          if (j.status === 'running') { clear(actions).append(h('span', { class: 'dim' }, `${j.label}${j.bytes ? ' · ' + formatBytes(j.bytes) : ''}…`)); continue; }
          if (j.status !== 'done') throw new Error(j.error || 'The download failed');
          break;
        }
        clear(actions).append(restartBtn(info.latest), h('button', { class: 'btn sm ghost', onclick: async () => { await call('POST', '/api/update/cancel').catch(() => {}); refresh(); } }, 'Not now'));
        note.textContent = 'Downloaded and checked. Restarting installs it; your files, settings and dumps aren’t touched. If the new version doesn’t start, the old one comes back on its own.';
      } catch (e) {
        clear(actions).append(h('button', { class: 'btn sm', onclick: () => check() }, 'Try again'));
        note.textContent = e.message;
      }
    };

    const check = async () => {
      clear(out);
      clear(actions).append(h('span', { class: 'dim' }, 'Checking GitHub…'));
      let info;
      try { info = await call('POST', '/api/update/check'); } catch (e) { note.textContent = e.message; clear(actions).append(h('button', { class: 'btn sm', onclick: () => check() }, 'Check again')); return; }
      if (!info.newer) {
        note.textContent = `You’re up to date (${info.current}).`;
        clear(actions).append(h('button', { class: 'btn sm', onclick: () => check() }, icon('refresh', 'sm'), 'Check again'));
        return;
      }
      note.textContent = `${info.latest} is available (you have ${info.current}).`;
      if (info.notes?.length) out.append(h('ul', { class: 'update-notes' }, info.notes.map((n) => h('li', {}, n))));
      for (const w of info.warnings || []) out.append(h('div', { class: 'update-warn' }, icon('alert', 'sm'), w));
      clear(actions);
      if (st?.blocked) { out.append(h('div', { class: 'update-warn' }, icon('info', 'sm'), st.blocked)); return; }
      if (info.warnings?.length) return;
      actions.append(h('button', { class: 'btn sm primary', onclick: () => download(info) }, icon('download', 'sm'), `Download ${info.latest}`));
    };

    const renderToken = () => {
      clear(tokenRow);
      if (st?.hasToken) {
        tokenRow.append(h('span', { class: 'dim', style: { fontSize: '12px' } }, '● GitHub token saved (only used to reach a private repo)'),
          h('button', { class: 'btn sm ghost', onclick: async () => { try { await call('POST', '/api/update/token', { token: null }); st.hasToken = false; renderToken(); } catch (e) { errorToast(e); } } }, 'Remove'));
        return;
      }
      const input = h('input', { type: 'password', placeholder: 'GitHub token, only if the repo is private', autocomplete: 'off', spellcheck: 'false', style: { flex: '1', minWidth: '220px' } });
      tokenRow.append(input, h('button', { class: 'btn sm', onclick: async () => {
        try { await call('POST', '/api/update/token', { token: input.value }); st.hasToken = true; renderToken(); toast('Token saved', { type: 'ok' }); } catch (e) { errorToast(e); }
      } }, 'Save'));
    };

    const refresh = async () => {
      try { st = await fetch('/api/update/status', { headers: H }).then((r) => r.json()); } catch { line.textContent = 'Couldn’t read the update status.'; return; }
      line.textContent = `v${st.version} · updates from github.com/${st.repo}`;
      note.textContent = st.blocked || '';
      clear(out);
      clear(actions);
      if (st.pending && !st.blocked) {
        note.textContent = `${st.pending.version} is downloaded and ready.`;
        actions.append(restartBtn(st.pending.version), h('button', { class: 'btn sm ghost', onclick: async () => { await call('POST', '/api/update/cancel').catch(() => {}); refresh(); } }, 'Discard it'));
      } else {
        actions.append(h('button', { class: 'btn sm', onclick: () => check() }, icon('refresh', 'sm'), 'Check for updates'));
      }
      actions.append(h('button', { class: 'btn sm ghost', onclick: () => this.showWhatsNew() }, 'What’s new'));
      const last = st.backups?.[0];
      if (last && !st.blocked) actions.append(h('button', { class: 'btn sm ghost', 'data-tip': 'Puts back the version from before the last update', onclick: async () => {
        if (!(await confirmDialog(`Go back to ${last.from}?`, `Box-Deckspitter restarts on ${last.from}, the version you had before updating to ${last.version}. Your files, settings and dumps aren’t touched.`, { okLabel: `Go back to ${last.from}` }))) return;
        try { await call('POST', '/api/update/rollback'); toast('Restarting…', { timeout: 4000 }); } catch (e) { errorToast(e); }
      } }, icon('undo', 'sm'), `Go back to ${last.from}`));
      renderToken();
    };
    refresh();
    const auto = h('input', { type: 'checkbox', checked: this.settings.updateCheckOnLaunch !== false });
    auto.addEventListener('change', () => this.saveSettings({ updateCheckOnLaunch: auto.checked }));
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Updates'), line, note, out, actions, h('label', { class: 'check' }, auto, 'Check for updates when the app starts'), tokenRow);
  }

  windowsSettings() {
    const LINUX = this.info?.platform === 'linux';
    const OS = LINUX ? 'Linux' : 'Windows';
    const status = h('span', { class: 'dim mono', style: { fontSize: '11px' } }, 'checking…');
    const actions = h('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Request failed'); return d; });
    const refresh = async () => {
      let st;
      try { st = await fetch('/api/system/associations', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()); } catch { st = { supported: false }; }
      clear(actions);
      if (!st.supported) { status.textContent = 'Not available on this system.'; return; }
      status.textContent = st.count ? `● registered for ${st.count} file type${st.count === 1 ? '' : 's'}` : `○ not registered with ${OS} yet`;
      if (st.moved) status.textContent += ' — the app folder moved, click “Choose file types” to update';
      actions.append(...[
        h('button', { class: 'btn sm', onclick: () => this.fileTypesDialog(st.registered || {}, post, st).then(refresh) }, icon('file', 'sm'), st.count ? 'Change file types…' : 'Choose file types…'),
        st.count && !st.linux ? h('button', { class: 'btn sm primary', onclick: () => post('/api/system/default-apps').catch(errorToast) }, 'Set as default…') : null,
        st.count ? h('button', { class: 'btn sm ghost', onclick: async () => {
          if (!(await confirmDialog(`Remove from ${OS}?`, st.linux ? 'Box-Deckspitter stops being the default for these file types and leaves “Open with”. They go back to the app your system picks.'
            : 'Box-Deckspitter will disappear from “Open with” and Default apps. Files you had set to open with it go back to Windows asking which app to use.', { okLabel: 'Remove', danger: true }))) return;
          try { await post('/api/system/associations/remove'); toast(`Removed from ${OS}`, { type: 'ok' }); } catch (e) { errorToast(e); }
          refresh();
        } }, 'Remove') : null].filter(Boolean));
    };
    refresh();
    const shortcutBtn = window.bdsShell?.createShortcuts ? h('button', { class: 'btn sm', onclick: async () => {
      try {
        const made = await window.bdsShell.createShortcuts();
        toast(!made.length ? 'Couldn’t create the shortcuts' : LINUX ? 'Added to your app menu (it can take a moment to show up)'
          : 'Added to the Start menu and Desktop — right-click either one (or the open window’s taskbar button) → Pin to taskbar', { type: made.length ? 'ok' : 'error', timeout: 6000 });
      } catch (e) { errorToast(e); }
    } }, icon('pin', 'sm'), LINUX ? 'Add to the app menu' : 'Add to Start menu & Desktop') : null;
    const about = h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Open PDFs, documents, text and config files with Box-Deckspitter when you double-click them.');
    if (LINUX) return h('div', { class: 'settings-group' }, h('h4', {}, 'Linux'), about, status, actions, shortcutBtn);
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Windows'),
      about, status, actions,
      shortcutBtn,
      shortcutBtn ? h('span', { class: 'faint', style: { fontSize: '11px' } }, 'To pin it: right-click Box-Deckspitter’s button on the taskbar while it’s open → Pin to taskbar.') : null);
  }

  async fileTypesDialog(current, post, st = {}) {
    const OS = st.linux ? 'Linux' : 'Windows';
    const GROUPS = [
      ['pdf', 'PDF documents', ['pdf'], true],
      ['doc', 'Word & rich text', ['docx', 'doc', 'odt', 'rtf'], true],
      ['text', 'Text & notes', ['txt', 'log', 'md', 'markdown'], true],
      ['config', 'Config files', ['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'properties'], true],
      ['sheet', 'Spreadsheets', ['xlsx', 'xls', 'ods', 'csv', 'tsv'], true],
      ['mail', 'Saved emails', ['eml'], true],
      ['playlist', 'Shared playlists', ['plylst'], true],
      ['code', 'Code', ['js', 'ts', 'py', 'ps1', 'bat', 'cmd', 'sh', 'css', 'lua', 'sql'], false],
      ['web', 'Web pages', ['html', 'htm'], false],
      ['image', 'Images', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'], false],
      ['video', 'Videos', ['mp4', 'mkv', 'webm', 'mov', 'avi'], false],
    ];
    // Linux has no file type for some of these (.ini, .ps1…): those aren't offered there
    if (st.exts) for (const g of GROUPS) g[2] = g[2].filter((e) => st.exts.includes(e));
    const has = Object.keys(current).length;
    const boxes = GROUPS.map(([id, label, exts, def]) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = has ? exts.some((e) => current[e]) : def;
      return { id, exts, cb, row: h('label', { class: 'check filetype-row' }, cb, h('span', {}, label), h('span', { class: 'faint mono' }, exts.map((e) => '.' + e).join(' '))) };
    });
    const res = await modal({
      title: 'Open these with Box-Deckspitter', wide: true,
      body: h('div', { class: 'filetypes' },
        h('div', { class: 'faint', style: { fontSize: '12px', marginBottom: '10px' } }, st.linux ? 'Box-Deckspitter becomes the default app for these types (just for your account, no admin needed). Anything you don’t tick stays with the app it opens with now.'
          : 'Box-Deckspitter registers itself with Windows for these types (just for your account, no admin needed). Then Windows asks you to confirm it as the default — apps aren’t allowed to do that part by themselves.'),
        ...boxes.map((b) => b.row)),
      buttons: [{ label: 'Cancel', value: null, ghost: true }, { label: 'Register', value: 'ok', primary: true }],
    });
    if (res !== 'ok') return;
    const groups = {};
    for (const b of boxes) if (b.cb.checked) groups[b.id] = b.exts;
    if (!Object.keys(groups).length) {
      await post('/api/system/associations/remove').catch(() => {});
      return toast(`No file types selected — removed from ${OS}.`, { timeout: 3000 });
    }
    const done = toast(`Registering with ${OS}…`, { timeout: 0 });
    try {
      const res = await post('/api/system/associations', { groups });
      done();
      if (res.linux) return toast(`Box-Deckspitter now opens ${res.count} file types when you double-click them`, { type: 'ok', timeout: 5000 });
      const next = await modal({
        title: 'One more step',
        body: h('div', {},
          h('p', {}, `Box-Deckspitter is now registered for ${res.count} file types and shows up in “Open with”.`),
          h('p', {}, 'To make it the default, Windows Settings will open on Box-Deckspitter’s page: click ', h('b', {}, 'Set default'), ' at the top (or pick it per file type).')),
        buttons: [{ label: 'Later', value: null, ghost: true }, { label: 'Open Default apps', value: 'go', primary: true }],
      });
      if (next === 'go') await post('/api/system/default-apps');
    } catch (e) { done(); errorToast(e, 'Could not register'); }
  }

  // ======================================================================= email settings

  mailSettings() {
    const list = h('div', { class: 'mail-acct-list' });
    const draw = (accounts) => {
      clear(list);
      if (!accounts.length) list.append(h('span', { class: 'faint', style: { fontSize: '11px' } }, 'No accounts yet.'));
      for (const a of accounts) {
        list.append(h('div', { class: 'row mail-acct-row' }, icon('mail', 'sm'), h('span', { class: 'grow mono', style: { fontSize: '11.5px' } }, a.address),
          h('button', { class: 'btn sm ghost', onclick: async () => {
            if (!(await confirmDialog('Remove account?', `BoxMail will forget ${a.address} and its app password. Nothing in your Gmail changes.`, { okLabel: 'Remove', danger: true }))) return;
            const r = await fetch('/api/mail/accounts/remove', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: a.id }) }).then((x) => x.json());
            draw(r.accounts || []);
            for (const t of this.tabs) if (t.mode === 'mail' && t.editor && !t.editor.emlMode) t.editor.load(null);
          } }, 'Remove')));
      }
    };
    fetch('/api/mail/accounts', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).then((r) => draw(r.accounts || [])).catch(() => draw([]));
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Email (BoxMail)'),
      list,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: async () => {
          const { addMailAccountDialog } = await import('../editors/mail.js');
          const accounts = await addMailAccountDialog();
          if (accounts) { draw(accounts); for (const t of this.tabs) if (t.mode === 'mail' && t.editor && !t.editor.emlMode) { clear(t.pane); t.editor.load(null); } }
        } }, icon('plus', 'sm'), 'Add Gmail account…'),
        h('button', { class: 'btn sm ghost', onclick: () => this.newDocument('mail') }, 'Open BoxMail')),
      h('label', { class: 'check' }, (() => {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = this.settings.mailBlockImages === true;
        cb.addEventListener('change', () => this.saveSettings({ mailBlockImages: cb.checked }));
        return cb;
      })(), 'Block remote images until I click Load (stops senders seeing when you open their email)'),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Uses Google app passwords, stored only on this PC. Browsing never marks mail as read.'));
  }

  // ======================================================================= AI assistant settings

  aiSettings() {
    const setKey = async (provider, key) => {
      const r = await fetch('/api/ai/key', { method: 'POST', headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, key }) });
      if (!r.ok) throw new Error((await r.json()).error);
    };
    const rows = h('div', { class: 'col', style: { gap: '6px' } }, h('span', { class: 'dim mono', style: { fontSize: '11px' } }, 'checking…'));
    const refresh = async () => {
      const s = await fetch('/api/ai/status', { headers: { 'X-BDS-Token': api.token } }).then((r) => r.json()).catch(() => ({}));
      clear(rows).append(...Object.entries(PROVIDERS).map(([id, P]) => {
        const st = s.providers?.[id] || {};
        return h('div', { class: 'row', style: { gap: '6px' } },
          h('b', { style: { width: '84px', fontSize: '12px' } }, P.name),
          h('span', { class: 'dim mono grow', style: { fontSize: '11px' } }, st.configured ? `● key saved (${st.keyHint})${st.fromEnv ? ` from ${st.fromEnv}` : ''}` : '○ no key'),
          h('button', { class: 'btn sm', onclick: async () => { const k = await promptDialog(`${P.company} API key`, `Paste a key from ${P.keyUrl}`, '', { type: 'password', placeholder: P.placeholder }); if (!k) return; try { await setKey(id, k); toast('Key saved', { type: 'ok' }); refresh(); } catch (e) { errorToast(e); } } }, st.configured ? 'Change…' : 'Set key…'),
          st.configured && !st.fromEnv ? h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog(`Remove the ${P.company} key?`, `${P.name} will stop working in the AI assistant until you add a key again.`, { okLabel: 'Remove', danger: true })) { await setKey(id, ''); refresh(); } } }, 'Remove') : null);
      }));
      this.rightPanels?.ai?.panel?.refreshStatus();
    };
    refresh();
    return h('div', { class: 'settings-group' }, h('h4', {}, 'AI assistant'),
      rows,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm ghost', onclick: () => this.toggleRightPanel(this.rightPanel === 'ai' && !this.panelOnTop('ai') ? null : 'ai') }, 'Open panel')),
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'Optional. Add a key for any of these and pick which one to use at the top of the panel. Text goes to that company only when you press send, billed to your account with them. Keys are sealed to your Windows account.'));
  }

  // ======================================================================= discord settings

  discordSettings() {
    const s = this.settings;
    const savePresence = debounce((patch) => { this.saveSettings(patch); this.presence.update(); }, 350);
    const set = (patch) => { Object.assign(s, patch); renderPreview(); savePresence(patch); };

    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = !!s.discordEnabled;
    enabled.addEventListener('change', () => { set({ discordEnabled: enabled.checked }); body.hidden = !enabled.checked; });

    const idIn = h('input', { type: 'text', placeholder: 'Application ID (numbers)', value: s.discordClientId || '', spellcheck: 'false', class: 'mono' });
    idIn.addEventListener('input', () => set({ discordClientId: idIn.value.trim() }));

    const modeSeg = h('div', { class: 'seg' });
    const autoBox = h('div', { class: 'col' });
    const customBox = h('div', { class: 'col' });
    for (const [m, label] of [['auto', 'Automatic'], ['custom', 'Custom']]) {
      const b = h('button', { class: (s.discordMode || 'auto') === m ? 'on' : '' }, label);
      b.addEventListener('click', () => {
        [...modeSeg.children].forEach((x) => x.classList.toggle('on', x === b));
        autoBox.hidden = m !== 'auto';
        customBox.hidden = m !== 'custom';
        set({ discordMode: m });
      });
      modeSeg.append(b);
    }
    autoBox.hidden = (s.discordMode || 'auto') !== 'auto';
    customBox.hidden = s.discordMode !== 'custom';

    const styleSel = h('select', {}, h('option', { value: 'silly' }, 'Silly lines (“centering a div”)'), h('option', { value: 'plain' }, 'Plain lines (“Editing a .pdf”)'));
    styleSel.value = s.discordStyle || 'silly';
    styleSel.addEventListener('change', () => set({ discordStyle: styleSel.value }));
    autoBox.append(h('span', { class: 'dim' }, 'Picks a line from the kind of file you have open.'), styleSel);

    const detailsIn = h('input', { type: 'text', maxlength: '120', placeholder: 'top line, e.g. editing a .{ext}', value: s.discordDetails ?? 'spitting out documents' });
    const stateIn = h('input', { type: 'text', maxlength: '120', placeholder: 'second line, e.g. {tabs} tabs deep', value: s.discordState ?? '' });
    detailsIn.addEventListener('input', () => set({ discordDetails: detailsIn.value }));
    stateIn.addEventListener('input', () => set({ discordState: stateIn.value }));
    customBox.append(
      h('span', { class: 'dim' }, 'Top line'), detailsIn,
      h('span', { class: 'dim' }, 'Second line'), stateIn,
      h('span', { class: 'faint mono', style: { fontSize: '10.5px' } }, 'placeholders: {ext} → pdf · {kind} → spreadsheet · {tabs} → 3'));

    const timeCb = h('input', { type: 'checkbox' });
    timeCb.checked = s.discordShowTime !== false;
    timeCb.addEventListener('change', () => set({ discordShowTime: timeCb.checked }));
    const songCb = h('input', { type: 'checkbox' });
    songCb.checked = !!s.discordSong;
    songCb.addEventListener('change', () => set({ discordSong: songCb.checked }));

    // preview card styled after Discord's profile activity
    const pvDetails = h('div', { class: 'dp-line strong' });
    const pvState = h('div', { class: 'dp-line' });
    const pvTime = h('div', { class: 'dp-line faint' });
    const preview = h('div', { class: 'discord-preview' },
      h('div', { class: 'dp-head' }, 'playing a game'),
      h('div', { class: 'dp-body' }, h('img', { src: '/assets/icon.svg', class: 'dp-img', alt: '' }),
        h('div', { class: 'dp-text' }, h('div', { class: 'dp-line strong' }, 'Box-Deckspitter'), pvDetails, pvState, pvTime)));
    const statusEl = h('div', { class: 'dp-status mono' });
    const statusText = {
      off: 'off', connecting: 'connecting to Discord…', connected: '● connected — showing on your profile',
      'discord-not-running': 'Discord desktop app isn’t running', 'discord-closed': 'Discord closed the connection',
      'bad-id': 'that Application ID doesn’t look right',
    };
    const renderStatus = (st) => {
      statusEl.textContent = statusText[st] || st || '';
      statusEl.classList.toggle('ok', st === 'connected');
      statusEl.classList.toggle('bad', /not-running|bad-id|closed|error/.test(st || ''));
    };
    const renderPreview = () => {
      const a = this.presence.preview();
      pvDetails.textContent = a.details || '';
      pvState.textContent = a.state || '';
      pvTime.textContent = a.start ? '00:42 elapsed' : '';
      pvState.hidden = !a.state;
      pvTime.hidden = !a.start;
    };
    this.onPresenceStatus = renderStatus;
    renderPreview();
    renderStatus(this.presenceStatus);

    const exportLogo = h('button', {
      class: 'btn sm',
      onclick: async () => {
        const img = new Image();
        img.src = '/assets/icon.svg';
        await img.decode();
        const c = h('canvas', { width: 1024, height: 1024 });
        c.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        this.saveBytesAs(blob, { defaultName: 'box-deckspitter-logo.png', filters: [{ name: 'PNG image', extensions: ['png'] }], openAfter: false });
      },
    }, icon('download', 'sm'), 'Save logo PNG');

    const body = h('div', { class: 'col' },
      h('span', { class: 'dim' }, 'Application ID'), idIn,
      h('details', { class: 'dp-help' }, h('summary', {}, 'how do I get one?'),
        h('ol', {},
          h('li', {}, 'Open discord.com/developers/applications'),
          h('li', {}, 'New Application → name it “Box-Deckspitter” (that name shows as “Playing …”)'),
          h('li', {}, 'Copy the Application ID and paste it above'),
          h('li', {}, 'Optional: Rich Presence → Art Assets → upload the logo PNG named “logo”')),
        exportLogo),
      h('span', { class: 'dim' }, 'Mode'), modeSeg, autoBox, customBox,
      h('label', { class: 'check' }, timeCb, 'Show elapsed time'),
      h('label', { class: 'check', title: 'While the music player is playing, the second line shows the song’s name' }, songCb, 'Show the song I’m listening to'),
      preview, statusEl,
      h('span', { class: 'faint', style: { fontSize: '11px' } }, 'File names and folders are never sent — only what you type here, the kind of file, and (if you turn it on) the song’s name.'));
    body.hidden = !enabled.checked;

    if (s.discordEnabled) api.presenceStatus().then((r) => renderStatus(r.status)).catch(() => {});
    return h('div', { class: 'settings-group' }, h('h4', {}, 'Discord'),
      h('label', { class: 'check' }, enabled, 'Show what I’m doing in Discord'), body);
  }

  // ======================================================================= keys, dnd, lifecycle
}
