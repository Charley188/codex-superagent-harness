// Small Windows shell for the local Codex workbench. No model, worker or policy logic lives here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program {
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try {
            var config = Json.Read(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.json"));
            string root = Json.Text(config, "root"), key = Json.Text(config, "instance_key");
            bool first;
            using (var mutex = new Mutex(true, "Local\\CodexSuperagent-" + key, out first)) {
                if (!first) {
                    for (int i = 0; i < 30; i++) {
                        EventWaitHandle existing;
                        if (EventWaitHandle.TryOpenExisting("Local\\CodexSuperagent-Open-" + key, out existing)) {
                            using (existing) { if (Array.IndexOf(args, "--no-browser") < 0) existing.Set(); }
                            return;
                        }
                        Thread.Sleep(100);
                    }
                    throw new Exception("工作台正在启动，请稍后再双击图标。");
                }
                try { using (var shell = new Workbench(config, Array.IndexOf(args, "--no-browser") < 0)) Application.Run(shell); }
                finally { mutex.ReleaseMutex(); }
            }
        } catch (Exception e) { MessageBox.Show(e.Message, "Codex Superagent", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }
}
internal static class Json {
    public static Dictionary<string, object> Parse(string data) { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(data); }
    public static Dictionary<string, object> Read(string path) { return Parse(File.ReadAllText(path, Encoding.UTF8)); }
    public static string Text(Dictionary<string, object> data, string key) { return data.ContainsKey(key) ? Convert.ToString(data[key]) : ""; }
}
internal sealed class Connection {
    public Uri Url; public int Pid; public DateTime Started;
    public Connection(string path) {
        var data = Json.Read(path); Url = new Uri(Json.Text(data, "url")); Pid = Convert.ToInt32(data["pid"]);
        Started = DateTime.Parse(Json.Text(data, "started_at")).ToUniversalTime();
        if (Url.Scheme != "http" || Url.Host != "127.0.0.1" || Url.AbsolutePath != "/" || Url.UserInfo != "" || Url.Query != "" || !Regex.IsMatch(Url.Fragment, "^#[a-f0-9]{64}$")) throw new Exception("工作台地址无效。");
    }
    public Dictionary<string, object> Call(string endpoint, string body = null) {
        var request = (HttpWebRequest)WebRequest.Create(new Uri(Url, "/api/" + endpoint));
        request.Proxy = null; request.KeepAlive = false; request.Timeout = body == null ? 2500 : 86400000;
        request.ReadWriteTimeout = request.Timeout;
        request.Headers[HttpRequestHeader.Authorization] = "Bearer " + Url.Fragment.Substring(1);
        if (body != null) {
            request.Method = "POST"; request.ContentType = "application/json";
            var bytes = Encoding.UTF8.GetBytes(body); request.ContentLength = bytes.Length;
            using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        }
        using (var response = request.GetResponse()) using (var reader = new StreamReader(response.GetResponseStream())) return Json.Parse(reader.ReadToEnd());
    }
}
internal sealed class Workbench : ApplicationContext {
    readonly Dictionary<string, object> config;
    readonly string root, directory;
    readonly Form dispatcher = new Form();
    readonly NotifyIcon tray;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly EventWaitHandle openEvent;
    readonly RegisteredWaitHandle waiter;
    Connection connection; Process owned;
    bool opening, polling, quitting, disposed;
    int missed;
    string logDirectory;
    Form progress;
    public Workbench(Dictionary<string, object> settings, bool openBrowser) {
        config = settings; root = Json.Text(config, "root"); directory = Path.Combine(root, "state", "dsh-core", "framework-local");
        var handle = dispatcher.Handle;
        tray = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = "Codex Superagent · 正在启动", Visible = true };
        var menu = new ContextMenuStrip(); menu.Items.Add("打开工作台", null, (s,e) => Open(true)); menu.Items.Add(new ToolStripSeparator()); menu.Items.Add("退出 Codex Superagent", null, (s,e) => Quit());
        tray.ContextMenuStrip = menu;
        tray.MouseClick += (s,e) => { if (e.Button == MouseButtons.Left) Open(true); };
        openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\CodexSuperagent-Open-" + Json.Text(config, "instance_key"));
        waiter = ThreadPool.RegisterWaitForSingleObject(openEvent, (s,t) => OnUI(() => Open(true)), null, -1, false);
        timer.Interval = 2000; timer.Tick += (s,e) => Poll(); timer.Start();
        Open(openBrowser);
    }
    void OnUI(Action action) { if (!disposed && !dispatcher.IsDisposed) { try { dispatcher.BeginInvoke(action); } catch (InvalidOperationException) {} } }
    void ShowProgress(string text) {
        if (progress != null) return;
        progress = new Form { Text = "Codex Superagent", Size = new Size(420,145), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ControlBox = false };
        progress.Controls.Add(new Label { Text = text, Dock = DockStyle.Fill, Padding = new Padding(24), Font = new Font("Microsoft YaHei UI",11) }); progress.Show();
    }
    void HideProgress() { if (progress != null) { progress.Close(); progress.Dispose(); progress = null; } }
    Connection ReadRunning() {
        try { var c = new Connection(Path.Combine(directory,"connection.json")); var s = c.Call("status"); return s.ContainsKey("projects") && s.ContainsKey("paused") ? c : null; } catch { return null; }
    }
    async void Open(bool browser) {
        if (opening || quitting || disposed) return; opening = true;
        if (connection == null && browser) ShowProgress("正在打开工作台，请稍候…\n启动后会自动打开浏览器。");
        try {
            connection = await Task.Run(() => {
                var c = ReadRunning(); if (c != null) return c;
                if (owned != null && !owned.HasExited) throw new Exception("后台服务正在响应，请稍后重试。");
                Launch();
                for (int i = 0; i < 240; i++) {
                    c = ReadRunning(); if (c != null) return c;
                    if (owned.HasExited) throw new Exception("工作台未能启动。请查看启动记录：\n" + logDirectory);
                    Thread.Sleep(250);
                }
                throw new Exception("启动时间较长，可稍后再次点击图标。启动记录：\n" + logDirectory);
            });
            HideProgress(); missed = 0; tray.Text = "Codex Superagent · 后台运行";
            if (browser) Process.Start(new ProcessStartInfo(connection.Url.AbsoluteUri) { UseShellExecute = true });
        } catch (Exception e) { HideProgress(); MessageBox.Show(e.Message, "打开工作台", MessageBoxButtons.OK, MessageBoxIcon.Information); if (owned == null || owned.HasExited) ExitThread(); }
        finally { opening = false; }
    }
    void Launch() {
        string node = Json.Text(config,"node"), python = Json.Text(config,"python");
        if (!File.Exists(node) || !File.Exists(python)) throw new Exception("Node 或 Python 的安装位置已变化。请重新运行 desktop\\build.ps1 更新入口。");
        logDirectory = Path.Combine(root,"state","desktop","launches",DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0,8)); Directory.CreateDirectory(logDirectory);
        var start = new ProcessStartInfo(node,"--experimental-transform-types framework/cli.mjs serve") { WorkingDirectory = Path.Combine(root,"prototypes","dsh-core"), UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        start.EnvironmentVariables["PATH"] = Path.GetDirectoryName(node) + ";" + Path.GetDirectoryName(python) + ";" + start.EnvironmentVariables["PATH"];
        // Explorer may not have inherited the desktop app's Codex PATH. Resolve the newest installed bundle each launch.
        string bundles = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"OpenAI","Codex","bin");
        if (Directory.Exists(bundles)) {
            string[] candidates = Directory.GetFiles(bundles,"codex.exe",SearchOption.AllDirectories);
            Array.Sort(candidates,(a,b) => File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)));
            if (candidates.Length > 0) start.EnvironmentVariables["PATH"] = Path.GetDirectoryName(candidates[0]) + ";" + start.EnvironmentVariables["PATH"];
        }
        owned = new Process { StartInfo = start };
        owned.OutputDataReceived += (s,e) => Log("stdout.log",e.Data); owned.ErrorDataReceived += (s,e) => Log("stderr.log",e.Data);
        owned.Start(); owned.BeginOutputReadLine(); owned.BeginErrorReadLine();
    }
    void Log(string name,string line) { if (line != null) { try { File.AppendAllText(Path.Combine(logDirectory,name),Regex.Replace(line,"#[a-f0-9]{64}","#[local-token]") + Environment.NewLine,Encoding.UTF8); } catch {} } }
    bool ConfirmedStopped() {
        try { var s = Json.Read(Path.Combine(directory,"shutdown.json")); return Json.Text(s,"state") == "stopped" && Convert.ToInt32(s["pid"]) == connection.Pid && DateTime.Parse(Json.Text(s,"at")).ToUniversalTime() >= connection.Started; } catch { return false; }
    }
    async void Poll() {
        if (polling || opening || quitting || connection == null || disposed) return; polling = true;
        try {
            var state = await Task.Run(() => connection.Call("lifecycle")); missed = 0;
            string phase = Json.Text(state,"state"); tray.Text = "Codex Superagent · " + (phase == "draining" ? "完成当前工作后退出" : phase == "stopping" ? "正在退出" : Convert.ToBoolean(state["paused"]) ? "已暂停" : "后台运行");
            if (phase == "stopped") ExitThread();
        } catch {
            if (ConfirmedStopped()) ExitThread();
            else if (++missed >= 5) { timer.Stop(); MessageBox.Show("与后台服务的连接已中断。记录仍保留在本机；再次打开时会核查未完成的执行。", "Codex Superagent", MessageBoxButtons.OK, MessageBoxIcon.Information); ExitThread(); }
        } finally { polling = false; }
    }
    async void Quit() {
        if (quitting || opening || connection == null || disposed) return;
        try {
            var state = await Task.Run(() => connection.Call("lifecycle"));
            var active = (Dictionary<string,object>)state["active"]; bool busy = false; foreach (object n in active.Values) busy |= Convert.ToInt32(n) > 0;
            string mode = busy ? ChooseExit() : "now"; if (mode == null) return;
            quitting = true; tray.Text = "Codex Superagent · 正在退出";
            ShowProgress(mode == "drain" ? "等待当前工作完成后退出…\n尚未开始的工作会保留。" : "正在保存并退出，请稍候…");
            if (mode == "drain") {
                progress.Height = 210;
                var stop = new Button { Text = "现在停止并退出", Dock = DockStyle.Bottom, Height = 38 };
                stop.Click += async (s,e) => {
                    stop.Enabled = false;
                    try { await Task.Run(() => connection.Call("shutdown","{\"mode\":\"now\"}")); }
                    catch { if (!disposed) stop.Enabled = true; }
                };
                progress.Controls.Add(stop); stop.BringToFront();
            }
            var result = await Task.Run(() => connection.Call("shutdown","{\"mode\":\"" + mode + "\"}"));
            if (!result.ContainsKey("stopped") || !Convert.ToBoolean(result["stopped"])) throw new Exception("尚未收到退出确认。");
            HideProgress(); ExitThread();
        } catch (Exception e) { quitting = false; HideProgress(); MessageBox.Show("尚未确认退出，请打开工作台查看状态。\n" + e.Message,"Codex Superagent",MessageBoxButtons.OK,MessageBoxIcon.Information); }
    }
    string ChooseExit() {
        string mode = null;
        using (var dialog = new Form { Text = "还有工作正在执行", Size = new Size(560,205), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false }) {
            dialog.Controls.Add(new Label { Text = "当前工作完成后退出，或现在停止。任务记录都会保留。", AutoSize = false, Bounds = new Rectangle(20,20,510,55), Font = new Font("Microsoft YaHei UI",10) });
            var wait = new Button { Text = "完成当前工作后退出", Bounds = new Rectangle(20,95,180,36) };
            var stop = new Button { Text = "现在停止并退出", Bounds = new Rectangle(210,95,150,36) };
            var cancel = new Button { Text = "继续使用", Bounds = new Rectangle(370,95,145,36) };
            wait.Click += (s,e) => { mode = "drain"; dialog.Close(); }; stop.Click += (s,e) => { mode = "now"; dialog.Close(); }; cancel.Click += (s,e) => dialog.Close();
            dialog.Controls.AddRange(new Control[]{wait,stop,cancel}); dialog.CancelButton = cancel; dialog.ShowDialog();
        }
        return mode;
    }
    protected override void ExitThreadCore() {
        if (disposed) return; disposed = true; timer.Stop(); timer.Dispose(); HideProgress(); tray.Visible = false; tray.Dispose(); waiter.Unregister(null); openEvent.Dispose(); dispatcher.Dispose(); base.ExitThreadCore();
    }
}
