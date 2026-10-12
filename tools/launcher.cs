// Box-DocSpitter.exe: starts the app window (drag files onto it to open them). If the app window runtime
// (node_modules) is missing it sets it up first. The app rebuilds the .exe from this file whenever it changes,
// with the C# compiler that ships with Windows (see buildLauncher in server.js). C# 5: no $"" strings.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Box-DocSpitter")]
[assembly: AssemblyProduct("Box-DocSpitter")]

static class Launcher {
  const string Title = "Box-DocSpitter";

  [STAThread]
  static int Main(string[] argv) {
    try {
      string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
      string electron = Path.Combine(dir, @"node_modules\electron\dist\electron.exe");
      string app = Quote(Path.Combine(dir, @"electron\main.js"));
      StringBuilder args = new StringBuilder();
      foreach (string a in argv) args.Append(' ').Append(Quote(a));
      Directory.SetCurrentDirectory(dir);

      // Portable path: Electron brings its own Node, so nothing needs to be installed.
      if (File.Exists(electron)) { Run(electron, app + args, dir, false, true); return 0; }

      // Setup path: node_modules is missing or incomplete, so it needs Node.js and internet once.
      if (Run("cmd.exe", "/c where node >nul 2>nul", dir, true, false) != 0) {
        MessageBox.Show("Box-DocSpitter's app files (the node_modules folder) are missing.\r\n\r\n" +
          "Either copy the whole Box-DocSpitter folder again including node_modules, or install Node.js once\r\n" +
          "(winget install OpenJS.NodeJS.LTS) and start Box-DocSpitter again to download them.",
          Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
      }
      if (!Directory.Exists(Path.Combine(dir, "node_modules")))
        Run("cmd.exe", "/c title Box-DocSpitter setup && echo Installing Box-DocSpitter (one time)... && npm install --no-audit --no-fund && echo Done. && timeout /t 3", dir, true, true);
      if (!File.Exists(electron) && File.Exists(Path.Combine(dir, @"node_modules\electron\install.js")))
        // npm sometimes skips Electron's download step; fetch the app window runtime once.
        Run("cmd.exe", @"/c title Box-DocSpitter setup && echo Downloading the app window (one time)... && node node_modules\electron\install.js", dir, true, true);

      if (File.Exists(electron)) Run(electron, app + args, dir, false, true);
      else Run("node.exe", Quote(Path.Combine(dir, "server.js")) + " --app" + args, dir, false, false); // last resort: browser app window
      return 0;
    } catch (Exception e) {
      MessageBox.Show("Box-DocSpitter couldn't start:\r\n\r\n" + e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
      return 1;
    }
  }

  static int Run(string file, string args, string dir, bool wait, bool window) {
    ProcessStartInfo psi = new ProcessStartInfo(file, args);
    psi.WorkingDirectory = dir;
    psi.UseShellExecute = false;
    psi.CreateNoWindow = !window;
    using (Process p = Process.Start(psi)) {
      if (!wait) return 0;
      p.WaitForExit();
      return p.ExitCode;
    }
  }

  /** Quotes one argument the way Windows programs split their command line. */
  static string Quote(string s) {
    if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
    StringBuilder sb = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in s) {
      if (c == '\\') { slashes++; continue; }
      sb.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c);
      slashes = 0;
    }
    return sb.Append('\\', slashes * 2).Append('"').ToString();
  }
}
