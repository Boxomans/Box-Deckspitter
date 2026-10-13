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
      if (!HasNode(dir) && !InstallNode(dir)) return 1;
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

  static bool HasNode(string dir) { return Run("cmd.exe", "/c where node >nul 2>nul", dir, true, false) == 0; }

  /**
   * No Node.js: offer to install it with winget (Windows' own package manager) in a console you can watch, then
   * carry on with the setup. No winget (old Windows 10): offer the download page instead.
   */
  static bool InstallNode(string dir) {
    const string missing = "Box-DocSpitter's app files (the node_modules folder) are missing. They're downloaded once with " +
      "Node.js, which isn't installed.\r\n\r\n(Or copy the whole Box-DocSpitter folder again, including node_modules: then nothing needs installing.)";
    if (Run("cmd.exe", "/c where winget >nul 2>nul", dir, true, false) != 0) {
      if (MessageBox.Show(missing + "\r\n\r\nOpen nodejs.org to download Node.js? Install the LTS version, then start Box-DocSpitter again.",
          Title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
        Process.Start("https://nodejs.org/en/download");
      return false;
    }
    if (MessageBox.Show(missing + "\r\n\r\nInstall Node.js now? This runs:\r\n\r\n    winget install OpenJS.NodeJS.LTS\r\n\r\n" +
        "in a console window. Windows may ask for permission, and winget may ask you to accept its terms there. " +
        "Setup then carries on by itself.", Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
      return false;
    int code = Run("cmd.exe", "/c title Installing Node.js for Box-DocSpitter && winget install --id OpenJS.NodeJS.LTS --exact --source winget" +
      " || (echo. & echo Node.js didn't install. & pause & exit /b 1)", dir, true, true);
    // the installer puts Node.js on the PATH for new programs, not this one: point this one (and the setup it runs) at it
    foreach (string root in new string[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramW6432"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs") }) {
      if (string.IsNullOrEmpty(root)) continue;
      string nodeDir = Path.Combine(root, "nodejs");
      if (File.Exists(Path.Combine(nodeDir, "node.exe"))) {
        Environment.SetEnvironmentVariable("PATH", nodeDir + ";" + Environment.GetEnvironmentVariable("PATH"));
        break;
      }
    }
    if (HasNode(dir)) return true;
    MessageBox.Show(code == 0
      ? "Node.js is installed, but Windows hasn't made it available yet. Start Box-DocSpitter again (or restart the PC first if it still says this)."
      : "Node.js wasn't installed. You can install it yourself from nodejs.org (the LTS version) and start Box-DocSpitter again.",
      Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    return false;
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
