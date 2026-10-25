// BoxComms: chat, file transfer and a push-to-talk radio with other copies of Box-Deckspitter on the same local
// network. Nothing to set up: switch it on and everyone else who has it on shows up. The server does the networking
// (comms-server.js); core/comms.js keeps the connection and the audio; this is the tab.
//
// Left, the people (the whole room, or one person for a private chat). Middle, the chat. Right, the radio and the
// room's settings, which are the same for everyone in it.

import { BaseEditor } from './base.js';
import { h, clear, formatBytes, timeAgo } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import { toast, errorToast, confirmDialog, promptDialog, contextMenu, draggedPaths } from '../core/ui.js';
import { pickOpen, pickFolder } from '../core/files.js';

const AUTO_DELETE = [[0, 'Never'], [5, 'After 5 minutes'], [60, 'After an hour'], [1440, 'After a day'], [10080, 'After a week'], [43200, 'After 30 days']];
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const FILE_STATUS = { offered: 'Waiting', receiving: 'Receiving…', sending: 'Sending…', done: 'Saved', delivered: 'Delivered', declined: 'Declined', failed: 'Didn’t arrive' };

export class CommsEditor extends BaseEditor {
  static mode = 'comms';

  get c() { return this.app.comms; }
  get cfg() { return { fx: true, beeps: true, volume: 0.9, chan: 1, ...(this.app.settings.comms || {}) }; }
  setCfg(patch) { this.app.saveSettings({ comms: { ...this.cfg, ...patch } }); }

  async load() {
    this.to = null; // null = everyone, or a person's id
    this.openedAt = Date.now();
    this.root = h('div', { class: 'comms-root' });
    this.pane.append(this.root);
    this.off = this.c.on((ev) => this.onEvent(ev));
    this.keyDown = (e) => this.ptt(e, true);
    this.keyUp = (e) => this.ptt(e, false);
    window.addEventListener('keydown', this.keyDown, true);
    window.addEventListener('keyup', this.keyUp, true);
    window.addEventListener('blur', this.keyUp);
    this.meter = setInterval(() => this.drawMeter(), 80);
    this.ago = setInterval(() => this.renderPeople(), 30000);
    this.render();
  }

  destroy() {
    this.off?.();
    window.removeEventListener('keydown', this.keyDown, true);
    window.removeEventListener('keyup', this.keyUp, true);
    window.removeEventListener('blur', this.keyUp);
    clearInterval(this.meter); clearInterval(this.ago);
    if (this.c.sending) this.c.talk(false);
  }

  onShow() { this.renderChat(); this.c.audio().catch(() => {}); }
  focus() { this.input?.focus(); }

  status() {
    const s = this.c.state;
    if (!s.on) return { left: [{ text: 'BoxComms is off' }], right: [] };
    return { left: [{ text: `${s.peers.length} other${s.peers.length === 1 ? '' : 's'} online`, icon: 'users' }], right: [{ text: `Channel ${s.me?.chan || 1}`, icon: 'radio' }] };
  }

  onEvent(ev) {
    switch (ev.type) {
      case 'state': this.render(); break;
      case 'me': this.renderShared(); // falls through
      case 'peers': this.renderPeople(); this.renderRadio(); if (this.to && !this.c.state.peers.some((p) => p.id === this.to)) this.renderChatHead(); break;
      case 'msg': case 'history': this.renderChat(); this.renderPeople(); break;
      case 'msg-update': this.updateCard(ev.msg); break;
      case 'progress': this.updateCard(this.c.state.history.find((m) => m.mid === ev.mid)); break;
      case 'shared': this.renderShared(); this.renderChatHead(); this.renderChat(); break;
      case 'talk': case 'ptt': this.renderPeople(); this.renderTalk(); break;
    }
    this.refreshStatus();
  }

  render() {
    const s = this.c.state;
    clear(this.root);
    if (!s.on) {
      this.root.append(this.offPage(),
        h('div', { class: 'comms-disclaimer' }, 'BoxComms hasn’t been security-tested or penetration-tested. Use it only on your home network or a VPN you trust.'));
      this.refreshStatus();
      return;
    }
    this.root.append(
      this.people = h('div', { class: 'comms-people' }),
      h('div', { class: 'comms-chat' },
        this.chatHead = h('div', { class: 'comms-chat-head' }),
        this.list = h('div', { class: 'comms-list' }),
        this.composer()),
      h('div', { class: 'comms-side' },
        this.radio = h('div', { class: 'comms-radio' }),
        this.sharedBox = h('div', { class: 'comms-shared' })));
    this.wireDrop(this.root);
    this.renderPeople();
    this.renderChatHead();
    this.renderChat();
    this.renderRadio();
    this.renderShared();
    this.refreshStatus();
  }

  offPage() {
    const name = h('input', { type: 'text', maxlength: '40', placeholder: 'Your name on the network', value: this.cfg.name || this.c.state.me?.name || '' });
    const go = async () => {
      this.setCfg({ name: name.value.trim() });
      try { await this.c.start(); } catch (e) { errorToast(e, 'BoxComms couldn’t start'); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'comms-off' },
      h('div', { class: 'comms-off-icon' }, icon('radio')),
      h('h2', {}, 'BoxComms'),
      h('p', { class: 'dim' }, 'Chat, send files and talk on a push-to-talk radio with anyone on the same network who has Box-Deckspitter and BoxComms on. No account, no internet, nothing to set up.'),
      h('label', { class: 'comms-off-name' }, h('span', { class: 'dim' }, 'Name'), name),
      h('label', { class: 'comms-off-name' }, h('span', { class: 'dim' }, 'Network'), this.netPicker(false)),
      h('button', { class: 'btn primary', onclick: go }, icon('power', 'sm'), 'Go on the network'),
      h('ul', { class: 'comms-notes faint' },
        h('li', {}, 'It stays on while the app is open (and comes back on next time) until you switch it off here.'),
        h('li', {}, 'Your firewall may ask the first time: allow it on private networks.'),
        h('li', {}, 'Messages, files and the radio are encrypted for each person; compare the safety code in a private chat to be sure nobody is in between. Channels aren’t private: anyone with BoxComms on the same channel hears you.'),
        h('li', {}, 'On a network that isn’t marked private and isn’t a VPN, it asks before going on.'),
        h('li', {}, 'Same network only: one router or Wi-Fi, or a virtual one like Hamachi or a VPN (pick it above). On a VPN that doesn’t find anyone by itself, add the other PC by its address in BoxComms once it’s on. Guest Wi-Fi that keeps devices apart blocks it.')));
  }

  // ---------------------------------------------------------------- people
  renderPeople() {
    if (!this.people?.isConnected) return;
    const s = this.c.state;
    const unread = (id) => s.history.filter((m) => m.from === id && m.to === s.me.id && m.rt > (this.seen?.[id] || this.openedAt || 0)).length;
    const row = (id, label, sub, ico, extra = '') => h('div', { class: `comms-person${this.to === id ? ' active' : ''}${extra}`, onclick: () => this.pick(id) },
      h('span', { class: 'comms-avatar' }, ico),
      h('span', { class: 'comms-person-text' }, h('span', { class: 'comms-person-name' }, label), sub ? h('span', { class: 'faint' }, sub) : null),
      id && unread(id) ? h('span', { class: 'comms-unread' }, String(unread(id))) : null);
    clear(this.people).append(
      h('div', { class: 'comms-me' },
        h('span', { class: 'comms-dot on' }),
        h('span', { class: 'comms-me-name', title: 'Double-click to change your name', ondblclick: () => this.rename() }, s.me.name),
        h('button', { class: 'icon-btn', 'data-tip': 'Go off the network', onclick: () => this.c.stop().catch(errorToast) }, icon('power', 'sm'))),
      h('div', { class: 'clock-sec-title' }, 'Room'),
      row(null, s.shared.room || 'Comms', `${s.peers.length + 1} here`, icon('users', 'sm')),
      h('div', { class: 'clock-sec-title' }, 'People'),
      ...(s.peers.length ? s.peers.map((p) => {
        const on = this.c.talking.has(p.id);
        return row(p.id, p.name, p.keyChanged ? '⚠ key changed' : on ? 'talking…' : `channel ${p.chan}${p.chan === s.me.chan ? ' (yours)' : ''}`, p.name.slice(0, 1).toUpperCase(), (on ? ' talking' : '') + (p.keyChanged ? ' warn' : ''));
      }) : [h('div', { class: 'faint comms-empty' }, 'Nobody else yet. Anyone on this network who switches BoxComms on shows up here.')]));
  }

  pick(id) {
    (this.seen ||= {})[this.to || '*'] = Date.now();
    this.to = id;
    this.seen[id || '*'] = Date.now();
    this.renderPeople(); this.renderChatHead(); this.renderChat();
    this.input?.focus();
  }

  async rename() {
    const n = await promptDialog('Your name on BoxComms', 'Name', this.c.state.me.name);
    if (!n?.trim()) return;
    this.setCfg({ name: n.trim().slice(0, 40) });
    this.c.start().catch(errorToast);
  }

  // ---------------------------------------------------------------- chat
  renderChatHead() {
    if (!this.chatHead?.isConnected) return;
    const s = this.c.state;
    const p = this.to && s.peers.find((x) => x.id === this.to);
    const gone = this.to && !p;
    clear(this.chatHead).append(
      h('div', { class: 'comms-chat-title' }, this.to ? (p?.name || this.c.nameOf(this.to)) : (s.shared.room || 'Comms'),
        h('span', { class: 'faint' }, this.to ? (gone ? ' · offline' : ' · private') : (s.shared.topic ? ` · ${s.shared.topic}` : ` · everyone`))),
      s.shared.autoDelete ? h('span', { class: 'comms-pill', title: 'Set in the room settings, for everyone' }, icon('clock', 'sm'), AUTO_DELETE.find(([v]) => v === s.shared.autoDelete)?.[1].replace('After', 'Gone after') || `Gone after ${s.shared.autoDelete} min`) : null,
      p?.keyChanged ? h('span', { class: 'comms-pill bad', title: 'This could be a new install on their side, or someone pretending to be them. Messages to and from them are held back.' }, '⚠ Their key changed',
        h('button', { class: 'btn sm', onclick: () => this.trustKey(p) }, 'Check…'))
        : p ? h('span', { class: 'comms-pill', title: 'Ask them what code they see for you (by phone or in person). The same code on both sides means nobody in between can read your messages.' }, icon('lock', 'sm'), `Safety code ${p.safety}`)
        : h('span', { class: 'comms-pill', title: 'Messages, files and the radio are sealed separately for each person.' }, icon('lock', 'sm'), 'Encrypted'));
  }

  async trustKey(p) {
    if (!(await confirmDialog(`Accept ${p.name}’s new key?`, `Their key changed since you first saw them. That happens when they reinstall or reset Box-Deckspitter, but it’s also what someone pretending to be them would look like. Ask ${p.name} (by phone or in person) what safety code they see: accept only if it’s ${p.safety}.`, { okLabel: 'The codes match', danger: true }))) return;
    this.c.trustKey(p.id).catch(errorToast);
  }

  shown() {
    // a file offered to the whole room is one card per person on the sender's side, all shown in the room
    return this.c.state.history.filter((m) => (this.to ? m.to && !m.room && (m.from === this.to || m.to === this.to) : !m.to || m.room));
  }

  renderChat() {
    if (!this.list?.isConnected) return;
    const near = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    const msgs = this.shown();
    clear(this.list);
    if (!msgs.length) this.list.append(h('div', { class: 'faint comms-empty' }, this.to ? 'Nothing here yet. Messages and files here go only to this person.' : 'Nothing here yet. Say hi to the room, or drop files in to send them.'));
    let last = null;
    for (const m of msgs) {
      const mine = m.from === this.c.state.me.id;
      const grouped = last && last.from === m.from && m.t - last.t < 180000;
      this.list.append(h('div', { class: `comms-msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`, 'data-mid': m.mid, oncontextmenu: (e) => this.msgMenu(e, m) },
        grouped ? null : h('div', { class: 'comms-msg-head' }, h('b', {}, mine ? 'You' : m.name), h('span', { class: 'faint', title: new Date(m.t).toLocaleString() }, hhmm(m.t))),
        m.kind === 'file' ? this.fileCard(m) : h('div', { class: 'comms-bubble' }, m.text, m.failed ? h('span', { class: 'comms-failed', title: `${m.failed} didn’t get it` }, ' ⚠') : null)));
      last = m;
    }
    if (near || this.stick !== false) this.list.scrollTop = this.list.scrollHeight;
    this.stick = undefined;
  }

  fileCard(m) {
    const mine = m.from === this.c.state.me.id;
    const f = m.file;
    const got = this.c.progress.get(m.mid);
    const card = h('div', { class: `comms-file st-${f.status}`, 'data-card': m.mid },
      h('span', { class: 'comms-file-icon' }, icon('file')),
      h('div', { class: 'comms-file-text' },
        h('div', { class: 'comms-file-name', title: f.name }, f.name),
        h('div', { class: 'faint' }, formatBytes(f.size), ' · ', mine ? `to ${this.c.nameOf(m.to)} · ` : '', FILE_STATUS[f.status] || f.status, f.error ? ` (${f.error})` : ''),
        f.status === 'receiving' && f.size ? h('div', { class: 'comms-bar' }, h('i', { style: { width: `${Math.round(((got || 0) / f.size) * 100)}%` } })) : null),
      h('div', { class: 'comms-file-btns' },
        !mine && f.status === 'offered' ? [
          h('button', { class: 'btn sm primary', onclick: () => this.c.answer(m.mid, true).catch(errorToast) }, icon('download', 'sm'), 'Accept'),
          h('button', { class: 'btn sm ghost', onclick: () => this.c.answer(m.mid, false).catch(errorToast) }, 'Decline')] : null,
        f.saved ? [
          h('button', { class: 'btn sm', onclick: () => this.app.openPath(f.saved) }, 'Open'),
          h('button', { class: 'icon-btn', 'data-tip': 'Show in folder', onclick: () => api.reveal(f.saved).catch(errorToast) }, icon('folder', 'sm'))] : null));
    return card;
  }

  updateCard(m) {
    if (!m || !this.list?.isConnected) return;
    const old = this.list.querySelector(`[data-card="${CSS.escape(m.mid)}"]`);
    if (old) old.replaceWith(this.fileCard(m));
    else if (this.list.querySelector(`[data-mid="${CSS.escape(m.mid)}"]`)) this.renderChat();
  }

  msgMenu(e, m) {
    contextMenu(e, [
      m.text ? { label: 'Copy', icon: 'copy', action: () => navigator.clipboard.writeText(m.text) } : null,
      m.kind === 'msg' && m.from !== this.c.state.me.id && this.c.state.peers.some((p) => p.id === m.from) ? { label: `Message ${m.name} privately`, icon: 'user', action: () => this.pick(m.from) } : null,
      { label: 'Delete on this PC', icon: 'trash', action: () => this.c.remove(m.mid).catch(errorToast) },
    ].filter(Boolean));
  }

  composer() {
    this.input = h('textarea', { class: 'comms-input', rows: '1', maxlength: '4000', placeholder: 'Message' });
    const send = async () => {
      const text = this.input.value;
      if (!text.trim()) return;
      if (this.to && !this.c.state.peers.some((p) => p.id === this.to)) return toast(`${this.c.nameOf(this.to)} is offline.`, { type: 'warn' });
      this.input.value = '';
      this.grow();
      this.stick = true;
      try { await this.c.say(text, this.to); } catch (e) { this.input.value = text; errorToast(e, 'Not sent'); }
    };
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    this.input.addEventListener('input', () => this.grow());
    return h('div', { class: 'comms-compose' },
      h('button', { class: 'icon-btn', 'data-tip': 'Send files', onclick: () => this.attach() }, icon('paperclip')),
      this.input,
      h('button', { class: 'btn primary', onclick: send }, icon('send', 'sm')));
  }
  grow() { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`; }

  async attach() {
    const paths = await pickOpen({ multi: true, title: 'Send files', filters: [{ name: 'All files', extensions: ['*'] }] });
    if (paths?.length) this.sendFiles(paths);
  }
  async sendFiles(paths) {
    const s = this.c.state;
    if (!s.shared.files) return toast('Files are switched off in this room’s settings.', { type: 'warn' });
    if (!s.peers.length) return toast('Nobody else is online to send to.', { type: 'warn' });
    if (!this.to && s.peers.length > 1 && !(await confirmDialog('Send to everyone?', `${paths.length === 1 ? 'This file is' : `These ${paths.length} files are`} offered to all ${s.peers.length} people in the room; each of them can accept or decline. To send to one person, pick them on the left first.`, { okLabel: 'Offer to everyone' }))) return;
    this.stick = true;
    try { await this.c.sendFiles(paths, this.to); } catch (e) { errorToast(e, 'Not sent'); }
  }
  wireDrop(el) {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files') || draggedPaths(e)?.length) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const paths = draggedPaths(e)?.length ? draggedPaths(e) : [...(e.dataTransfer?.files || [])].map((f) => window.bdsShell?.pathForFile?.(f)).filter(Boolean);
      if (!paths.length) return;
      e.preventDefault(); // so the app doesn't open them as well
      this.sendFiles(paths);
    });
  }

  // ---------------------------------------------------------------- radio
  renderRadio() {
    if (!this.radio?.isConnected) return;
    const s = this.c.state, c = this.cfg;
    const chan = h('select', { class: 'comms-chan' }, Array.from({ length: 16 }, (_, i) => h('option', { value: String(i + 1) }, `Channel ${i + 1}`)));
    chan.value = String(s.me.chan);
    chan.addEventListener('change', () => this.c.radio(Number(chan.value)).catch(errorToast));
    const vol = h('input', { type: 'range', min: '0', max: '1.5', step: '0.05', value: String(c.volume) });
    vol.addEventListener('input', () => { this.app.settings.comms = { ...c, volume: Number(vol.value) }; this.c.applyMix(); });
    vol.addEventListener('change', () => this.setCfg({ volume: Number(vol.value) }));
    const toggle = (key, label) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!c[key];
      cb.addEventListener('change', () => { this.setCfg({ [key]: cb.checked }); this.c.applyMix(); });
      return h('label', { class: 'check' }, cb, label);
    };
    const on = s.peers.filter((p) => p.chan === s.me.chan);
    this.pttBtn = h('button', { class: 'comms-ptt', title: 'Hold to talk (or hold Space when you’re not typing). Click Lock to keep it on.' }, icon('mic'), h('span', {}, 'Hold to talk'));
    const down = async (e) => { e.preventDefault(); this.pttBtn.setPointerCapture?.(e.pointerId); if (this.latched) { this.latched = false; this.c.talk(false); return; } await this.c.talk(true); };
    const up = () => { if (!this.latched) this.c.talk(false); };
    this.pttBtn.addEventListener('pointerdown', down);
    this.pttBtn.addEventListener('pointerup', up);
    this.pttBtn.addEventListener('pointercancel', up);
    clear(this.radio).append(
      h('div', { class: 'clock-sec-title' }, 'Radio'),
      chan,
      h('div', { class: 'faint comms-chan-who' }, on.length ? `On this channel: ${on.map((p) => p.name).join(', ')}` : 'Nobody else is on this channel.'),
      this.talkLine = h('div', { class: 'comms-talk' }),
      this.pttBtn,
      h('div', { class: 'row comms-ptt-row' },
        h('button', { class: 'btn sm ghost', title: 'Keep transmitting until you click again', onclick: async () => { if (this.c.sending) { this.latched = false; this.c.talk(false); } else if (await this.c.talk(true)) { this.latched = true; this.renderTalk(); } } }, icon('lock', 'sm'), 'Lock'),
        this.meterEl = h('div', { class: 'comms-meter', title: 'Your microphone' }, h('i'))),
      h('label', { class: 'row comms-vol' }, icon('volume', 'sm'), vol),
      toggle('fx', 'Radio sound (narrow, a little crackly)'),
      toggle('beeps', 'Beeps when someone starts and stops'),
      h('div', { class: 'faint comms-hint' }, 'Microphone and speakers: Settings → Audio devices.'));
    this.renderTalk();
  }

  renderTalk() {
    if (!this.talkLine?.isConnected) return;
    const who = [...this.c.talking].map((id) => this.c.nameOf(id));
    this.pttBtn.classList.toggle('on', this.c.sending);
    this.pttBtn.querySelector('span').textContent = this.c.sending ? (this.latched ? 'On air · click to stop' : 'On air') : 'Hold to talk';
    clear(this.talkLine).append(who.length ? h('span', { class: 'comms-talking' }, icon('volume', 'sm'), `${who.join(', ')} talking`) : h('span', { class: 'faint' }, 'Quiet'));
  }

  drawMeter() {
    const bar = this.meterEl?.firstChild;
    if (bar) bar.style.width = `${Math.min(100, Math.round(Math.sqrt(this.c.level) * 100))}%`;
  }

  /** Space to talk, when the BoxComms tab is in front and you're not typing somewhere. */
  ptt(e, down) {
    if (e.type === 'blur') { if (this.c.sending && !this.latched) this.c.talk(false); return; }
    if (e.code !== 'Space' || this.app.active !== this.tab || !this.c.state.on) return;
    const t = e.target;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"], .modal')) return;
    e.preventDefault();
    if (down && !e.repeat) { this.latched = false; this.c.talk(true); } else if (!down && !this.latched) this.c.talk(false);
  }

  // ---------------------------------------------------------------- the room's settings (everyone's)
  renderShared() {
    if (!this.sharedBox?.isConnected) return;
    const s = this.c.state.shared;
    const by = s.by && s.rev ? `Last changed by ${s.by === this.c.state.me.id ? 'you' : this.c.nameOf(s.by)} ${timeAgo(s.rev)}` : 'Nobody has changed these yet.';
    const field = (key, attrs) => {
      const el = h('input', { type: 'text', value: s[key] || '', ...attrs });
      el.addEventListener('change', () => this.c.shared({ [key]: el.value.trim() }).catch(errorToast));
      return el;
    };
    const del = h('select', {}, AUTO_DELETE.map(([v, l]) => h('option', { value: String(v) }, l)));
    if (!AUTO_DELETE.some(([v]) => v === s.autoDelete)) del.append(h('option', { value: String(s.autoDelete) }, `After ${s.autoDelete} minutes`));
    del.value = String(s.autoDelete || 0);
    del.addEventListener('change', () => this.c.shared({ autoDelete: Number(del.value) }).catch(errorToast));
    const files = h('input', { type: 'checkbox' });
    files.checked = s.files !== false;
    files.addEventListener('change', () => this.c.shared({ files: files.checked }).catch(errorToast));
    const max = h('select', {}, [[0, 'Any size'], [10, 'Up to 10 MB'], [100, 'Up to 100 MB'], [1024, 'Up to 1 GB'], [10240, 'Up to 10 GB']].map(([v, l]) => h('option', { value: String(v) }, l)));
    max.value = String(s.maxFileMB || 0);
    max.addEventListener('change', () => this.c.shared({ maxFileMB: Number(max.value) }).catch(errorToast));
    clear(this.sharedBox).append(
      h('div', { class: 'clock-sec-title' }, 'Room settings'),
      h('div', { class: 'faint comms-hint' }, 'The same for everyone here: a change anyone makes applies to all.'),
      h('span', { class: 'dim' }, 'Room name'), field('room', { maxlength: '40' }),
      h('span', { class: 'dim' }, 'Topic'), field('topic', { maxlength: '200', placeholder: 'What this room is for' }),
      h('span', { class: 'dim' }, 'Delete messages'), del,
      h('label', { class: 'check' }, files, 'Files can be sent'),
      max,
      h('button', { class: 'btn sm danger', onclick: async () => {
        if (await confirmDialog('Clear the chat for everyone?', 'Every message and file offer so far goes, on every PC in the room that’s online now (and on the others when they next come on). Files already saved stay where they are.', { okLabel: 'Clear for everyone', danger: true })) this.c.wipe().catch(errorToast);
      } }, icon('eraser', 'sm'), 'Clear chat for everyone'),
      h('div', { class: 'faint comms-hint' }, by),
      h('div', { class: 'clock-sec-title' }, 'On this PC'),
      h('span', { class: 'dim' }, 'Network'), this.netPicker(true),
      this.c.state.me.netUp ? null : h('div', { class: 'comms-warn' }, `${this.c.state.me.net} isn’t connected right now.`),
      h('span', { class: 'dim' }, 'Other PCs by address'),
      this.extraList(),
      h('div', { class: 'faint comms-hint', title: this.c.state.me.folder }, `Files you accept go to ${this.c.state.me.folder}`),
      h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm', onclick: () => this.changeFolder() }, icon('folder', 'sm'), 'Change…'),
        h('button', { class: 'btn sm ghost', onclick: async () => { if (await confirmDialog('Clear your chat history?', 'Only on this PC. Everyone else keeps theirs.', { okLabel: 'Clear mine' })) this.c.clearMine().catch(errorToast); } }, icon('trash', 'sm'), 'Clear mine')));
  }

  /** Which network BoxComms runs on: all of them, or one (Hamachi, a VPN, one of several adapters). */
  netPicker(live) {
    const cur = this.cfg.net || '';
    const el = h('select', { class: 'comms-net' }, h('option', { value: '' }, 'All networks (automatic)'), cur ? h('option', { value: cur }, cur) : null);
    el.value = cur;
    this.c.networks().then((list) => {
      clear(el).append(h('option', { value: '' }, 'All networks (automatic)'),
        ...list.map((n) => h('option', { value: n.name }, `${n.name} · ${n.addrs.join(', ')}`)),
        cur && !list.some((n) => n.name === cur) ? h('option', { value: cur }, `${cur} (not connected)`) : null);
      el.value = cur;
    });
    el.addEventListener('change', () => { this.setCfg({ net: el.value }); if (live) this.c.start().catch(errorToast); });
    return el;
  }

  /** PCs added by address or name, for VPNs that don't pass the broadcasts copies find each other with. */
  extraList() {
    const list = this.cfg.extra || [];
    const save = (extra) => { this.setCfg({ extra }); this.c.start().then(() => this.renderShared()).catch(errorToast); };
    const input = h('input', { type: 'text', placeholder: 'e.g. 25.12.34.56 or a PC name' });
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      if (!/^[\w.-]{1,253}$/.test(v)) return toast('That doesn’t look like an address or PC name.', { type: 'warn' });
      save([...new Set([...list, v])]);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    return h('div', { class: 'comms-extra' },
      ...list.map((x) => h('div', { class: 'comms-extra-row' }, h('span', { class: 'mono' }, x),
        h('button', { class: 'icon-btn', 'data-tip': 'Remove', onclick: () => save(list.filter((y) => y !== x)) }, icon('x', 'sm')))),
      h('div', { class: 'row', style: { gap: '6px' } }, input, h('button', { class: 'btn sm', onclick: add }, 'Add')),
      h('div', { class: 'faint comms-hint' }, `Only one side needs to add the other. Yours: ${this.c.state.me.addrs.join(', ') || 'none on this network'}`));
  }

  async changeFolder() {
    const dir = await pickFolder({ title: 'Where files you accept go', initialDir: this.c.state.me.folder });
    if (!dir) return;
    this.setCfg({ folder: dir });
    this.c.start().catch(errorToast);
  }
}
