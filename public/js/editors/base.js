// Base class for every editor mode. Each open tab owns one editor instance.

export class BaseEditor {
  static mode = 'base';

  constructor(app, tab) {
    this.app = app;
    this.tab = tab;
    this.pane = tab.pane;
    this.findBar = null;
    this.zoomLevel = 1;
  }

  /** Load content. bytes is null for a brand-new document. */
  async load(bytes, opts) {}

  /** Toolbar element shown above the workspace (or null). */
  buildToolbar() { return null; }

  /** Extra menu items, keyed by top-level menu: { edit, view, insert, format, tools }. */
  menus() { return {}; }

  /** Status bar entries: { left: [...], right: [...] } where each is {text, title, action, icon, cls}. */
  status() { return { left: [], right: [] }; }

  /** Formats this editor can save natively. First entry is the default. [{ext, name}] */
  saveFormats() { return []; }

  /** Extra export targets: [{label, ext, icon, run: async () => {}}]. */
  exportTargets() { return []; }

  /** Serialize for the given extension. Returns Uint8Array | string | Blob. */
  async serialize(ext) { throw new Error('Saving is not supported in this mode'); }

  /** Called after a successful save to the given path/ext. */
  afterSave(path, ext) {}

  /** Plain text snapshot used for crash-recovery drafts (null = no drafts). */
  getDraft() { return null; }
  restoreDraft(content) {}

  /** Whether lossy-format warnings should be shown when saving to ext. */
  lossyFormat(ext) { return false; }

  find(replace) {}
  undo() { document.execCommand('undo'); }
  redo() { document.execCommand('redo'); }
  print() { window.print(); }
  zoom(delta) {}
  focus() {}
  onShow() {}
  onHide() {}
  onThemeChange() {}
  destroy() {}

  /** Editors that handle Ctrl+F etc. themselves (Monaco) return true. */
  handlesKey(e) { return false; }

  markDirty() { this.app.setDirty(this.tab, true); }
  refreshStatus() { this.app.updateStatus(this.tab); }
}
