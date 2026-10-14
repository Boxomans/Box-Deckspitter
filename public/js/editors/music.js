// The Music tab: the music player laid out big, as a tab (the same player as the ♪ button — one at a time).

import { BaseEditor } from './base.js';
import { h } from '../core/dom.js';

export class MusicEditor extends BaseEditor {
  static mode = 'music';

  async load() {
    this.host = h('div', { class: 'music-page music-stage' });
    this.pane.append(this.host);
    this.app.music?.showInTab(this.host);
  }

  onShow() { if (this.host) this.app.music?.showInTab(this.host); }
  onHide() { this.app.music?.showInTab(null); }
  destroy() { this.app.music?.showInTab(null); }

  status() { return { left: [{ text: 'Music', icon: 'music' }, { text: 'audio-dump' }], right: [{ text: 'Space: play / pause' }] }; }
  saveFormats() { return []; }
}
