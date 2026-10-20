/*
 * AgroGardSklad.exe — нативный лаунчер приложения «ИТ-Склад AgroGard (Local Edition)».
 *
 * Принцип работы:
 *  1. При первом запуске извлекает встроенные ресурсы:
 *     - файлы веб-приложения (app.zip) -> %LocalAppData%\AgroGardSklad\app\
 *     - WebView2Loader.dll             -> %LocalAppData%\AgroGardSklad\runtime\
 *  2. Открывает окно WinForms с WebView2 (Chromium Edge, уже установлен в Windows)
 *     и загружает index.html по file://.
 *  3. Данные IndexedDB хранятся в %LocalAppData%\AgroGardSklad\webview2\
 *     и сохраняются между запусками.
 *
 * Совместимо с C# 5 (компилятор .NET Framework 4.x, встроенный в Windows).
 */
using System;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace AgroGardSklad
{
    internal static class Program
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        internal static readonly string RootDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgroGardSklad");
        internal static readonly string AppDir = Path.Combine(RootDir, "app");
        internal static readonly string RuntimeDir = Path.Combine(RootDir, "runtime");
        internal static readonly string UserDataDir = Path.Combine(RootDir, "webview2");

        // Увеличьте версию при обновлении встроенных файлов приложения
        internal const string AppVersion = "1.1";

        [STAThread]
        private static void Main()
        {
            // Однофайловая сборка: управляемые сборки WebView2 грузим из ресурсов
            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;

            bool created;
            using (Mutex mutex = new Mutex(true, "AgroGardSklad.SingleInstance", out created))
            {
                if (!created)
                {
                    MessageBox.Show("Приложение уже запущено.", "ИТ-Склад AgroGard",
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                try
                {
                    ExtractResources();
                }
                catch (Exception ex)
                {
                    MessageBox.Show("Не удалось подготовить файлы приложения:\n" + ex.Message,
                        "ИТ-Склад AgroGard", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }

        private static void ExtractResources()
        {
            Directory.CreateDirectory(AppDir);
            Directory.CreateDirectory(RuntimeDir);

            // Нативный загрузчик WebView2: кладём рядом и добавляем в путь поиска DLL
            string loader = Path.Combine(RuntimeDir, "WebView2Loader.dll");
            if (!File.Exists(loader))
                SaveResource("AgroGardSklad.WebView2Loader.dll", loader);
            SetDllDirectory(RuntimeDir);

            // Файлы приложения переизвлекаем только при смене версии
            string stamp = Path.Combine(AppDir, ".version");
            if (File.Exists(stamp) && File.ReadAllText(stamp) == AppVersion)
                return;

            string zipPath = Path.Combine(RuntimeDir, "app.zip");
            SaveResource("AgroGardSklad.app.zip", zipPath);
            if (Directory.Exists(AppDir)) Directory.Delete(AppDir, true);
            Directory.CreateDirectory(AppDir);
            ZipFile.ExtractToDirectory(zipPath, AppDir);
            File.WriteAllText(stamp, AppVersion);
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name == null || name.IndexOf("WebView2", StringComparison.OrdinalIgnoreCase) < 0)
                return null;
            using (Stream s = Assembly.GetExecutingAssembly()
                .GetManifestResourceStream("AgroGardSklad." + name + ".dll"))
            {
                if (s == null) return null;
                byte[] data = new byte[s.Length];
                s.Read(data, 0, data.Length);
                return Assembly.Load(data);
            }
        }

        private static void SaveResource(string name, string path)
        {
            using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (src == null) throw new InvalidOperationException("Ресурс не найден: " + name);
                using (Stream dst = File.Create(path)) src.CopyTo(dst);
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly WebView2 web;

        public MainForm()
        {
            Text = "ИТ-Склад AgroGard (Local Edition)";
            Width = 1440;
            Height = 900;
            MinimumSize = new Size(1100, 700);
            StartPosition = FormStartPosition.CenterScreen;

            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("AgroGardSklad.app.ico"))
                    if (s != null) Icon = new Icon(s);
            }
            catch { /* иконка необязательна */ }

            web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(web);
            Load += OnLoad;
        }

        private async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment
                    .CreateAsync(null, Program.UserDataDir);
                await web.EnsureCoreWebView2Async(env);

                // Заголовок окна = заголовок документа (показывает, что приложение загрузилось)
                web.CoreWebView2.DocumentTitleChanged += (s2, e2) =>
                {
                    string t = web.CoreWebView2.DocumentTitle;
                    if (!string.IsNullOrEmpty(t)) Text = t;
                };
                web.CoreWebView2.Navigate("file:///" + Program.AppDir.Replace('\\', '/') + "/index.html");
            }
            catch (Exception ex)
            {
                string msg = "Не удалось запустить WebView2.\n" + ex +
                    "\n\nУстановите «Microsoft Edge WebView2 Runtime» с сайта Microsoft и повторите запуск.";
                try { File.WriteAllText(Path.Combine(Program.RootDir, "error.log"), msg); } catch { }
                MessageBox.Show(msg, "ИТ-Склад AgroGard", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }
    }
}
