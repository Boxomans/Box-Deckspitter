// Screenshots with Win+Shift+Q, while the app runs: the screen dims, drag to grab an area or click a window to grab
// that window. The screen is captured at the press, so a fullscreen game that drops out of full screen under the overlay
// is still taken as it was; it's put back in front afterwards. The PNG goes straight into the media dump; the
// clipboard is never touched.
// Window positions come from a small PowerShell helper (Win32 calls), started on the first press and kept for a while;
// it also captures any screen that has Windows HDR on, which the usual capture gets wrong (see HDR_CS).

const { BrowserWindow, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'Super+Shift+Q';
const HELPER_IDLE = 10 * 60 * 1000;

// Top-level windows front to back (visible, not minimised, not hidden by Windows, with a title), the one in front and
// whether it fills its monitor. Physical pixels (per-monitor DPI aware); one JSON line per request.
const HELPER_CS = `
using System; using System.Text; using System.Runtime.InteropServices;
public static class BdsWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, int f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONINFO i);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONINFO { public int Size; public RECT Mon; public RECT Work; public int Flags; }
  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s) { if (c == '"' || c == '\\\\') b.Append('\\\\').Append(c); else if (c < 32) b.Append(' '); else b.Append(c); }
    return b.ToString();
  }
  static RECT Bounds(IntPtr h) { RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) GetWindowRect(h, out r); return r; }
  static string Cls(IntPtr h) { var c = new StringBuilder(128); GetClassName(h, c, 128); return c.ToString(); }
  static string Json(RECT r) { return "\\"x\\":" + r.L + ",\\"y\\":" + r.T + ",\\"w\\":" + (r.R - r.L) + ",\\"h\\":" + (r.B - r.T); }
  public static string List() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var sb = new StringBuilder("{\\"windows\\":[");
    bool first = true;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true; // tool windows
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.Length == 0) return true;
      RECT r = Bounds(h);
      if (r.R - r.L < 8 || r.B - r.T < 8) return true;
      if (!first) sb.Append(','); first = false;
      sb.Append("{" + Json(r) + ",\\"t\\":\\"" + Esc(t.ToString()) + "\\"}");
      return true;
    }, IntPtr.Zero);
    sb.Append("]");
    IntPtr fg = GetForegroundWindow();
    if (fg != IntPtr.Zero) {
      RECT r = Bounds(fg);
      var mi = new MONINFO(); mi.Size = Marshal.SizeOf(typeof(MONINFO));
      string cls = Cls(fg);
      bool full = GetMonitorInfo(MonitorFromWindow(fg, 2), ref mi) && cls != "Progman" && cls != "WorkerW" && cls != "Shell_TrayWnd"
        && r.L <= mi.Mon.L && r.T <= mi.Mon.T && r.R >= mi.Mon.R && r.B >= mi.Mon.B;
      sb.Append(",\\"front\\":{" + Json(r) + ",\\"full\\":" + (full ? "true" : "false") + ",\\"cls\\":\\"" + Esc(cls) + "\\",\\"hwnd\\":" + fg.ToInt64() + "}");
    }
    sb.Append("}");
    return sb.ToString();
  }
  // back to the window that was in front (a fullscreen game the overlay covered); allowed because the app that
  // started this helper has the foreground at that moment
  public static string Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    return SetForegroundWindow(h) ? "{\\"ok\\":true}" : "{\\"ok\\":false}";
  }
}`;
// Screens Windows has in HDR: desktop duplication hands those over as 16-bit float (linear scRGB, 1 = 80 nits), which
// is turned into an ordinary 8-bit picture here: divided by that screen's SDR white (the "SDR content brightness"
// setting), so the desktop comes out as it looks, with brighter-than-white highlights rolled off instead of cut flat.
// (The usual capture of an HDR screen comes out washed out or blown out.)
const HDR_CS = String.raw`
public static class BdsHdr {
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr f);
  [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr soft, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr dev, out int level, out IntPtr ctx);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, byte[] paths, ref uint nm, byte[] modes, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(byte[] packet);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  delegate int DQi(IntPtr self, ref Guid iid, out IntPtr o);
  delegate uint DRelease(IntPtr self);
  delegate int DEnum(IntPtr self, uint i, out IntPtr o);
  delegate int DGetDesc1(IntPtr self, IntPtr desc);
  delegate void DVoidPtr(IntPtr self, IntPtr p);
  delegate int DDup1(IntPtr self, IntPtr device, uint flags, uint n, int[] formats, out IntPtr dup);
  delegate int DAcquire(IntPtr self, uint timeout, IntPtr info, out IntPtr res);
  delegate int DSimple(IntPtr self);
  delegate int DCreateTex(IntPtr self, IntPtr desc, IntPtr init, out IntPtr tex);
  delegate void DCopy(IntPtr self, IntPtr dst, IntPtr src);
  delegate int DMap(IntPtr self, IntPtr res, uint sub, int type, uint flags, IntPtr mapped);
  delegate void DUnmap(IntPtr self, IntPtr res, uint sub);
  // a COM method by its place in the object's table
  static T Fn<T>(IntPtr o, int slot) where T : class {
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(o), slot * IntPtr.Size), typeof(T));
  }
  static void Rel(IntPtr p) { if (p != IntPtr.Zero) Fn<DRelease>(p, 2)(p); }
  static string Js(string s) { return s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
  static float F(IntPtr p, int off) { return BitConverter.ToSingle(BitConverter.GetBytes(Marshal.ReadInt32(p, off)), 0); }
  static string N(double v) { return v.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture); }

  // each screen's SDR white (the "SDR content brightness" slider), in scRGB units (1 = 80 nits), by \\.\DISPLAYn name
  static System.Collections.Generic.Dictionary<string, double> Whites() {
    var d = new System.Collections.Generic.Dictionary<string, double>();
    uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return d;
    byte[] paths = new byte[np * 72], modes = new byte[nm * 64];
    if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return d;
    for (int i = 0; i < np; i++) {
      int o = i * 72;
      byte[] src = new byte[84];
      BitConverter.GetBytes(1).CopyTo(src, 0); BitConverter.GetBytes(84).CopyTo(src, 4);
      Array.Copy(paths, o, src, 8, 8); Array.Copy(paths, o + 8, src, 16, 4);
      if (DisplayConfigGetDeviceInfo(src) != 0) continue;
      string name = Encoding.Unicode.GetString(src, 20, 64); int z = name.IndexOf('\0'); if (z >= 0) name = name.Substring(0, z);
      byte[] wl = new byte[24];
      BitConverter.GetBytes(11).CopyTo(wl, 0); BitConverter.GetBytes(24).CopyTo(wl, 4);
      Array.Copy(paths, o + 20, wl, 8, 8); Array.Copy(paths, o + 28, wl, 16, 4);
      if (DisplayConfigGetDeviceInfo(wl) == 0) d[name] = BitConverter.ToUInt32(wl, 20) / 1000.0;
    }
    return d;
  }

  static float[] Half; static byte[] Srgb;
  static void Luts() {
    if (Half != null) return;
    Half = new float[65536];
    for (int i = 0; i < 65536; i++) {
      int e = (i >> 10) & 31, m = i & 1023; double v;
      if (e == 0) v = m * Math.Pow(2, -24); else if (e == 31) v = m == 0 ? 65504 : 0; else v = (1 + m / 1024.0) * Math.Pow(2, e - 15);
      Half[i] = (float)((i & 0x8000) != 0 ? -v : v);
    }
    Srgb = new byte[16385];
    for (int i = 0; i <= 16384; i++) {
      double v = i / 16384.0, s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.Pow(v, 1 / 2.4) - 0.055;
      Srgb[i] = (byte)Math.Round(s * 255);
    }
  }
  static byte Enc(float v) { return v <= 0 ? (byte)0 : v >= 1 ? (byte)255 : Srgb[(int)(v * 16384 + 0.5f)]; }

  // linear scRGB halves → 8-bit sRGB BGRA. SDR content (up to the SDR white) comes out as it looks on the screen;
  // when brighter-than-white highlights are in the picture, the top of the range rolls off smoothly into white
  // instead of everything above white being cut flat
  static byte[] Tonemap(short[] px, int w, int h, double white, double peak, out double top) {
    Luts();
    int n = w * h; float k = (float)(1 / white);
    int[] hist = new int[4097];
    for (int i = 0, j = 0; i < n; i++, j += 4) {
      float r = Half[(ushort)px[j]], g = Half[(ushort)px[j + 1]], b = Half[(ushort)px[j + 2]];
      float m = Math.Max(r, Math.Max(g, b)) * k;
      hist[m <= 0 ? 0 : m >= 16 ? 4096 : (int)(m * 256)]++;
    }
    int cut = n / 1000, acc = 0, bin = 4096;
    while (bin > 0 && acc + hist[bin] <= cut) { acc += hist[bin]; bin--; }
    float M = (bin + 1) / 256f;
    if (peak > 1 && M > peak) M = (float)peak;
    top = M;
    bool curve = M > 1.02f;
    const float knee = 0.8f;
    float T = (M - knee) / (1 - knee);
    byte[] o = new byte[n * 4];
    for (int i = 0, j = 0; i < n; i++, j += 4) {
      float r = Math.Max(0, Half[(ushort)px[j]] * k), g = Math.Max(0, Half[(ushort)px[j + 1]] * k), b = Math.Max(0, Half[(ushort)px[j + 2]] * k);
      if (curve) {
        float m = Math.Max(r, Math.Max(g, b));
        if (m > knee) {
          float t = (m - knee) / (1 - knee);
          float y = knee + (1 - knee) * Math.Min(1, t * (1 + t / (T * T)) / (1 + t));
          float s = y / m; r *= s; g *= s; b *= s;
        }
      }
      o[j] = Enc(b); o[j + 1] = Enc(g); o[j + 2] = Enc(r); o[j + 3] = 255;
    }
    return o;
  }

  // one screen's desktop, as 16-bit float, through desktop duplication
  static string Capture(IntPtr o6, IntPtr dev, IntPtr ctx, double white, double peak, string file) {
    IntPtr dup;
    int hr = Fn<DDup1>(o6, 26)(o6, dev, 0, 1, new int[] { 10 }, out dup);
    if (hr != 0) throw new Exception("duplicate " + hr.ToString("X8"));
    IntPtr buf = Marshal.AllocHGlobal(256), res = IntPtr.Zero, tex = IntPtr.Zero, stg = IntPtr.Zero;
    short[] px; int w, h; bool frame = false;
    try {
      Fn<DVoidPtr>(dup, 7)(dup, buf);
      w = Marshal.ReadInt32(buf, 0); h = Marshal.ReadInt32(buf, 4);
      for (int i = 0; i < 6; i++) { hr = Fn<DAcquire>(dup, 8)(dup, 200, buf, out res); if (hr == 0) break; }
      if (hr != 0) throw new Exception("frame " + hr.ToString("X8"));
      frame = true;
      Guid gt = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
      if (Fn<DQi>(res, 0)(res, ref gt, out tex) != 0) throw new Exception("texture");
      Fn<DVoidPtr>(tex, 10)(tex, buf);
      if (Marshal.ReadInt32(buf, 16) != 10) throw new Exception("format " + Marshal.ReadInt32(buf, 16));
      w = Marshal.ReadInt32(buf, 0); h = Marshal.ReadInt32(buf, 4);
      int[] desc = { w, h, 1, 1, 10, 1, 0, 3, 0, 0x20000, 0 }; // staging copy the CPU can read
      Marshal.Copy(desc, 0, buf, desc.Length);
      hr = Fn<DCreateTex>(dev, 5)(dev, buf, IntPtr.Zero, out stg);
      if (hr != 0) throw new Exception("staging " + hr.ToString("X8"));
      Fn<DCopy>(ctx, 47)(ctx, stg, tex);
      hr = Fn<DMap>(ctx, 14)(ctx, stg, 0, 1, 0, buf);
      if (hr != 0) throw new Exception("map " + hr.ToString("X8"));
      long data = Marshal.ReadIntPtr(buf, 0).ToInt64(); int pitch = Marshal.ReadInt32(buf, IntPtr.Size);
      px = new short[w * h * 4];
      for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(data + (long)y * pitch), px, y * w * 4, w * 4);
      Fn<DUnmap>(ctx, 15)(ctx, stg, 0);
    } finally {
      if (frame) Fn<DSimple>(dup, 14)(dup);
      Rel(stg); Rel(tex); Rel(res); Rel(dup);
      Marshal.FreeHGlobal(buf);
    }
    double top;
    System.IO.File.WriteAllBytes(file, Tonemap(px, w, h, white, peak, out top));
    return "\"pw\":" + w + ",\"ph\":" + h + ",\"top\":" + N(top) + ",\"file\":\"" + Js(file) + "\"";
  }

  // every screen Windows has in HDR (or every screen, with all), captured to <dir>\hdr-N.raw (BGRA)
  public static string Grab(string dir, bool all) {
    var sb = new StringBuilder("{\"screens\":[");
    var errs = new StringBuilder();
    bool first = true; int n = 0;
    IntPtr fac = IntPtr.Zero;
    try {
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      Guid gf = new Guid("770aae78-f26f-4dba-a829-253c83d1b387"), g6 = new Guid("068346e8-aaec-4b84-add7-137f513f77a1");
      if (CreateDXGIFactory1(ref gf, out fac) != 0) throw new Exception("no DXGI");
      System.Collections.Generic.Dictionary<string, double> whites = null;
      int ps = IntPtr.Size;
      for (uint a = 0; ; a++) {
        IntPtr ad;
        if (Fn<DEnum>(fac, 12)(fac, a, out ad) != 0) break;
        IntPtr dev = IntPtr.Zero, ctx = IntPtr.Zero;
        try {
          for (uint i = 0; ; i++) {
            IntPtr op, o6 = IntPtr.Zero;
            if (Fn<DEnum>(ad, 7)(ad, i, out op) != 0) break;
            IntPtr d = Marshal.AllocHGlobal(256);
            try {
              if (Fn<DQi>(op, 0)(op, ref g6, out o6) != 0) continue;
              Fn<DGetDesc1>(o6, 27)(o6, d);
              string name = Marshal.PtrToStringUni(d);
              int L = Marshal.ReadInt32(d, 64), T = Marshal.ReadInt32(d, 68), R = Marshal.ReadInt32(d, 72), B = Marshal.ReadInt32(d, 76);
              int rot = Marshal.ReadInt32(d, 84), cs = Marshal.ReadInt32(d, 92 + ps);
              float maxLum = F(d, 132 + ps);
              bool hdr = cs == 12; // DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020: Windows HDR is on for this screen
              if (!hdr && !all) continue;
              if (rot > 1) { errs.Append(name + " is rotated; "); continue; }
              if (whites == null) whites = Whites();
              double white = hdr ? (whites.ContainsKey(name) ? whites[name] : 2.5) : 1;
              if (white < 0.5) white = 2.5;
              double peak = hdr && maxLum > 0 ? maxLum / 80.0 / white : 0;
              if (dev == IntPtr.Zero) {
                int fl;
                int hr = D3D11CreateDevice(ad, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, 7, out dev, out fl, out ctx);
                if (hr != 0) { dev = ctx = IntPtr.Zero; throw new Exception("no D3D11 " + hr.ToString("X8")); }
              }
              string file = System.IO.Path.Combine(dir, "hdr-" + (n++) + ".raw");
              try {
                string got = Capture(o6, dev, ctx, white, peak, file);
                if (!first) sb.Append(','); first = false;
                sb.Append("{\"name\":\"" + Js(name) + "\",\"x\":" + L + ",\"y\":" + T + ",\"w\":" + (R - L) + ",\"h\":" + (B - T)
                  + ",\"hdr\":" + (hdr ? "true" : "false") + ",\"white\":" + N(white) + ",\"peak\":" + N(peak) + "," + got + "}");
              } catch (Exception e) { errs.Append(name + ": " + e.Message + "; "); }
            } finally { Marshal.FreeHGlobal(d); Rel(o6); Rel(op); }
          }
        } catch (Exception e) { errs.Append(e.Message + "; "); }
        finally { Rel(ctx); Rel(dev); Rel(ad); }
      }
    } catch (Exception e) { errs.Append(e.Message); }
    finally { Rel(fac); }
    sb.Append("],\"err\":\"" + Js(errs.ToString().Trim()) + "\"}");
    return sb.ToString();
  }
}`;
const HELPER_PS = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${HELPER_CS}
${HDR_CS}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.StartsWith('hdr ')) { [Console]::Out.WriteLine([BdsHdr]::Grab($line.Substring(6), $line[4] -eq '1')) }
  elseif ($line.StartsWith('focus ')) { [Console]::Out.WriteLine([BdsWin]::Focus([long]$line.Substring(6))) }
  else { [Console]::Out.WriteLine([BdsWin]::List()) }
  [Console]::Out.Flush()
}`;

// The overlay page: the frozen screen, dimmed, with the area or window that would be taken lit up.
const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#000;cursor:crosshair;user-select:none}
canvas{position:fixed;inset:0;width:100vw;height:100vh}
#hint{position:fixed;top:18px;left:50%;transform:translateX(-50%);padding:7px 14px;border-radius:8px;background:rgba(10,8,16,.86);
color:#e8e2f4;font:13px/1.3 "Segoe UI",system-ui,sans-serif;border:1px solid rgba(255,255,255,.14);pointer-events:none;white-space:nowrap}
#size{position:fixed;padding:2px 6px;border-radius:4px;background:rgba(10,8,16,.86);color:#e8e2f4;font:11px "Cascadia Mono",Consolas,monospace;pointer-events:none;display:none}
</style><canvas id="c"></canvas><div id="hint">Drag to grab an area · click a window · Esc to cancel</div><div id="size"></div>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'), size = document.getElementById('size');
let img = null, wins = [], drag = null, hover = null, done = false;
const fit = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio; draw(); };
const under = (x, y) => wins.find((w) => x >= w.x && y >= w.y && x < w.x + w.w && y < w.y + w.h) || null;
const rectOf = (d) => ({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) });
function draw() {
  if (!img) return;
  const k = devicePixelRatio, sx = img.naturalWidth / innerWidth, sy = img.naturalHeight / innerHeight;
  g.drawImage(img, 0, 0, c.width, c.height);
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, c.width, c.height);
  const r = drag && drag.moved ? rectOf(drag) : hover;
  size.style.display = 'none';
  if (!r) return;
  const x = Math.max(0, r.x), y = Math.max(0, r.y), w = Math.min(innerWidth, r.x + r.w) - x, h = Math.min(innerHeight, r.y + r.h) - y;
  if (w <= 0 || h <= 0) return;
  g.drawImage(img, x * sx, y * sy, w * sx, h * sy, x * k, y * k, w * k, h * k);
  g.strokeStyle = '#ff8a3d'; g.lineWidth = 2 * k; g.strokeRect(x * k + k, y * k + k, w * k - 2 * k, h * k - 2 * k);
  size.textContent = Math.round(w * sx) + ' × ' + Math.round(h * sy);
  size.style.display = 'block';
  size.style.left = x + 'px'; size.style.top = (y > 26 ? y - 24 : y + h + 4) + 'px';
}
function finish(r) { if (done) return; done = true; window.snip.done(r); }
addEventListener('resize', fit);
addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
addEventListener('contextmenu', (e) => { e.preventDefault(); finish(null); });
addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false }; c.setPointerCapture(e.pointerId); });
addEventListener('pointermove', (e) => {
  if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; if (Math.abs(drag.x1 - drag.x0) + Math.abs(drag.y1 - drag.y0) > 4) drag.moved = true; }
  else hover = under(e.clientX, e.clientY) || { x: 0, y: 0, w: innerWidth, h: innerHeight, screen: true };
  draw();
});
addEventListener('pointerup', (e) => {
  if (!drag || e.button !== 0) return;
  const d = drag; drag = null;
  if (d.moved) { const r = rectOf(d); if (r.w >= 3 && r.h >= 3) finish({ ...r, kind: 'area', vw: innerWidth, vh: innerHeight }); else draw(); return; }
  const w = under(d.x0, d.y0);
  finish({ ...(w ? { x: w.x, y: w.y, w: w.w, h: w.h, kind: 'window', title: w.t } : { x: 0, y: 0, w: innerWidth, h: innerHeight, kind: 'screen' }), vw: innerWidth, vh: innerHeight });
});
window.snip.onData((d) => {
  wins = d.windows || [];
  if (d.hint) document.getElementById('hint').textContent = d.hint;
  if (d.img) { const i = new Image(); i.onload = () => { img = i; fit(); }; i.src = d.img; }
  else draw();
});
</script>`;

const OVERLAY_PRELOAD = path.join(__dirname, 'snip-preload.js');

module.exports = function createSnip({ dumpDir, notify, log = () => {} }) {
  // ---- the window-list helper
  let helper = null, idle = null, pending = [], buf = '';
  // run from a file: it's too long to pass on the command line
  const script = path.join(os.tmpdir(), 'bds-snip', `helper-${process.pid}.ps1`);
  function startHelper() {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '\ufeff' + HELPER_PS);
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const cb = pending.shift();
        if (cb) { try { cb(JSON.parse(line)); } catch { cb(null); } }
      }
    });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('exit', () => { if (helper === p) helper = null; if (err) log(`snip helper: ${err.trim().split('\n')[0]}`); for (const cb of pending.splice(0)) cb(null); });
    p.on('error', () => { if (helper === p) helper = null; });
    p.stdin.on('error', () => {});
    return p;
  }
  /** Windows front to back and the one in front, in physical pixels; null if the helper can't run. */
  const windowList = () => ask('list');
  /** Puts a window back in front (and un-minimises it). */
  const refocus = (hwnd) => (hwnd ? ask(`focus ${Math.trunc(Number(hwnd))}`) : Promise.resolve(null));
  function ask(cmd) {
    clearTimeout(idle);
    idle = setTimeout(() => { try { helper?.kill(); } catch { /* gone */ } helper = null; }, HELPER_IDLE);
    if (!helper) helper = startHelper();
    return new Promise((resolve) => {
      const t = setTimeout(() => { const k = pending.indexOf(done); if (k >= 0) pending.splice(k, 1); resolve(null); }, 8000);
      const done = (v) => { clearTimeout(t); resolve(v); };
      pending.push(done);
      try { helper.stdin.write(cmd + '\n'); } catch { done(null); }
    });
  }

  // ---- capturing and saving
  /** `promise`, or `fallback` once `ms` pass (a capture that never answers mustn't leave the key dead). */
  const within = (promise, ms, fallback) => Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);

  /** Every display's picture, at its own full resolution. Windows scales every screen to the size asked for, so
   *  each different screen size is asked for separately (side by side, it costs no extra time). */
  async function grabScreens() {
    const displays = screen.getAllDisplays();
    const native = (d) => ({ width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) });
    const sizes = [...new Map(displays.map((d) => { const n = native(d); return [`${n.width}x${n.height}`, n]; })).entries()];
    const got = new Map(await Promise.all(sizes.map(async ([k, n]) => [k, await within(desktopCapturer.getSources({ types: ['screen'], thumbnailSize: n }), 7000, [])])));
    return displays.map((d, i) => {
      const n = native(d);
      const sources = got.get(`${n.width}x${n.height}`) || [];
      return { display: d, image: (sources.find((s) => s.display_id === String(d.id)) || sources[i])?.thumbnail };
    }).filter((s) => s.image && !s.image.isEmpty());
  }

  /** The screens Windows has in HDR, captured by the helper and made SDR (see HDR_CS); [] when there are none.
   *  BDS_SNIP_HDR=all takes every screen that way, to check it on a PC without HDR. */
  async function grabHdr() {
    const dir = path.join(os.tmpdir(), 'bds-snip');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return []; }
    const res = await ask(`hdr ${process.env.BDS_SNIP_HDR === 'all' ? 1 : 0} ${dir}`);
    if (res?.err) log(`hdr capture: ${res.err}`);
    return (res?.screens || []).map((s) => {
      let image = null;
      try { image = nativeImage.createFromBitmap(fs.readFileSync(s.file), { width: s.pw, height: s.ph }); } catch { /* unreadable */ }
      try { fs.unlinkSync(s.file); } catch { /* already gone */ }
      log(`hdr screen ${s.name}: ${s.pw}×${s.ph}, SDR white ${Math.round(s.white * 80)} nits, brightest ${s.top}× white${s.hdr ? '' : ' (not HDR)'}`);
      const display = screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: s.x + s.w / 2, y: s.y + s.h / 2 }));
      return image && !image.isEmpty() ? { display, image } : null;
    }).filter(Boolean);
  }

  const two =(n) => String(n).padStart(2, '0');
  function save(image, title = '') {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
    fs.mkdirSync(dumpDir, { recursive: true });
    let file = path.join(dumpDir, `Screenshot ${stamp}.png`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dumpDir, `Screenshot ${stamp} (${n}).png`);
    fs.writeFileSync(file, image.toPNG());
    const { width, height } = image.getSize();
    notify({ path: file, name: path.basename(file), width, height, title });
    log(`screenshot: ${path.basename(file)} (${width}×${height})`);
  }
  /** `r` in DIPs relative to the display → the matching part of its full-resolution picture. */
  function crop(shot, r) {
    const { width: W, height: H } = shot.image.getSize();
    const kx = W / (r.vw || shot.display.bounds.width), ky = H / (r.vh || shot.display.bounds.height);
    const x = Math.max(0, Math.round(r.x * kx)), y = Math.max(0, Math.round(r.y * ky));
    const w = Math.min(W - x, Math.round(r.w * kx)), h = Math.min(H - y, Math.round(r.h * ky));
    return w > 0 && h > 0 ? shot.image.crop({ x, y, width: w, height: h }) : null;
  }
  const toDip = (r) => { try { return screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h }); } catch { return { x: r.x, y: r.y, width: r.w, height: r.h }; } };

  // ---- the overlay
  let busy = false, busySince = 0;
  let overlays = [];
  function closeOverlays() { for (const w of overlays) if (!w.isDestroyed()) w.destroy(); overlays = []; }
  ipcMain.on('bds:snip-done', (e, r) => {
    const o = overlays.find((w) => !w.isDestroyed() && w.webContents === e.sender);
    if (!o || !o.shot) return;
    const shot = o.shot;
    const back = o.refocus;
    const pick = o.pick;
    // the covered fullscreen app goes back in front while this app still has the foreground (Windows allows it then)
    (back ? refocus(back).then((res) => { if (!res?.ok) log('could not put the fullscreen app back in front'); }) : Promise.resolve()).finally(closeOverlays);
    busy = false;
    if (!r) return;
    if (pick) {
      // BoxStudio wants the area, not a picture: as fractions of that display, so any capture size fits
      const vw = r.vw || shot.display.bounds.width, vh = r.vh || shot.display.bounds.height;
      const fx = Math.max(0, r.x / vw), fy = Math.max(0, r.y / vh);
      pick({ displayId: String(shot.display.id), kind: r.kind, title: String(r.title || ''), x: fx, y: fy, w: Math.min(1 - fx, r.w / vw), h: Math.min(1 - fy, r.h / vh) });
      return;
    }
    const img = crop(shot, r);
    if (img) save(img, r.kind === 'window' ? String(r.title || '') : '');
  });

  // a game leaving full screen can switch the screen back to another resolution: the overlays follow it
  // (hooked up on the first press: the screen module only exists once the app is ready)
  let refitOn = false;
  const refit = (_e, d) => { for (const w of overlays) if (!w.isDestroyed() && w.displayId === d.id) w.setBounds(d.bounds); };

  function overlayFor(display) {
    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      enableLargerThanScreen: true, backgroundColor: '#000000', title: 'Screenshot',
      webPreferences: { preload: OVERLAY_PRELOAD, sandbox: true, contextIsolation: true, spellcheck: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setBounds(b); // again once it exists: Windows can resize it on a scaled display
    win.displayId = display.id;
    win.on('closed', () => { overlays = overlays.filter((w) => w !== win); if (!overlays.length) busy = false; });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML));
    overlays.push(win);
    return win;
  }

  /** Tells the app a screenshot didn't happen (it shows a notice), and notes why. */
  function fail(why) {
    log(`screenshot failed: ${why}`);
    notify({ error: why });
  }

  async function start({ pick = null, hint = '' } = {}) {
    // a press while one is open does nothing, unless that one got stuck
    if (busy && Date.now() - busySince < 20000) return;
    closeOverlays();
    busy = true;
    busySince = Date.now();
    log('key pressed');
    if (!refitOn) { screen.on('display-metrics-changed', refit); refitOn = true; }
    try {
      // the picture first (it's what was on screen at the press), the window list and the (hidden) overlays alongside
      const ready = screen.getAllDisplays().map((d) => [d.id, overlayFor(d)]);
      const [plain, list, hdr] = await Promise.all([grabScreens(), windowList(), grabHdr()]);
      // an HDR screen's own picture replaces the usual (washed-out) one
      const shots = plain.map((p) => hdr.find((h) => h.display.id === p.display.id) || p);
      for (const h of hdr) if (!shots.some((p) => p.display.id === h.display.id)) shots.push(h);
      const f = list?.front;
      log(`front window: ${f ? `${f.cls || '?'} ${f.w}×${f.h}${f.full ? ', fullscreen' : ''}` : 'unknown'}; screens captured: ${shots.length}${hdr.length ? ` (${hdr.length} HDR)` : ''}`);
      if (!shots.length) { closeOverlays(); busy = false; fail('Windows gave back no picture of the screen'); return; }
      // a fullscreen app in front (a game…): the picture is already taken, so it can drop out of full screen under
      // the overlay; it's put back in front when the overlay closes
      const back = f?.full ? f.hwnd : null;
      const wins = (list?.windows || []).map((w) => { const d = toDip(w); return { x: d.x, y: d.y, w: d.width, h: d.height, t: w.t }; });
      const cursor = screen.getCursorScreenPoint();
      for (const [id, win] of ready) {
        const shot = shots.find((s) => s.display.id === id);
        if (!shot) { win.destroy(); continue; }
        win.shot = shot;
        win.refocus = back;
        win.pick = pick;
        const b = shot.display.bounds;
        const local = wins.map((w) => ({ x: w.x - b.x, y: w.y - b.y, w: w.w, h: w.h, t: w.t }));
        win.loaded.then(() => {
          if (win.isDestroyed()) return;
          // shown as a JPEG (quick to make); the saved file is cut from the full PNG-quality picture
          win.webContents.send('bds:snip-data', { img: 'data:image/jpeg;base64,' + shot.image.toJPEG(88).toString('base64'), windows: local, hint });
          win.showInactive();
          if (cursor.x >= b.x && cursor.y >= b.y && cursor.x < b.x + b.width && cursor.y < b.y + b.height) win.focus();
        });
      }
    } catch (e) {
      closeOverlays();
      busy = false;
      fail(e.message);
    }
  }

  return {
    /** The same overlay, but the chosen area goes to cb (BoxStudio's record-this-area key) instead of a file. */
    pickArea(cb) { start({ pick: cb, hint: 'Drag the area to record · click a window · click the desktop for the whole screen · Esc to cancel' }); },
    /** Claim the key; false if something else on the PC has it. */
    register() {
      let ok = false;
      try { ok = globalShortcut.register(KEY, () => { start(); }); } catch { /* refused */ }
      log(ok ? 'Win+Shift+Q ready' : 'Win+Shift+Q is taken by another program');
      return ok;
    },
    dispose() {
      try { globalShortcut.unregister(KEY); } catch { /* not ours */ }
      if (refitOn) screen.removeListener('display-metrics-changed', refit);
      closeOverlays();
      try { helper?.kill(); } catch { /* gone */ }
      try { fs.unlinkSync(script); } catch { /* never made */ }
    },
    start,
  };
};
