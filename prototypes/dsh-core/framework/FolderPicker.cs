// Windows Common Item Dialog: https://learn.microsoft.com/windows/win32/shell/common-file-dialog
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class FolderPicker {
    [STAThread] static int Main() {
        Console.OutputEncoding = new UTF8Encoding(false);
        Application.EnableVisualStyles();
        IFileDialog dialog = null;
        try {
            dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
            uint options; dialog.GetOptions(out options);
            dialog.SetOptions(options | 0x20u | 0x40u | 0x800u | 0x02000000u);
            dialog.SetTitle("选择项目工作文件夹");
            dialog.SetOkButtonLabel("选择此文件夹");
            string initial = Environment.GetEnvironmentVariable("CODEX_PROJECT_FOLDER_INITIAL");
            if (!String.IsNullOrEmpty(initial) && Directory.Exists(initial)) {
                IShellItem folder; Guid iid = typeof(IShellItem).GUID;
                int hr = SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                if (hr >= 0) { try { dialog.SetFolder(folder); } finally { Marshal.ReleaseComObject(folder); } }
            }
            using (var owner = new Form { Text="Codex Superagent · 选择文件夹", ShowInTaskbar=false,
                StartPosition=FormStartPosition.CenterScreen, Size=new Size(1,1), Opacity=0, TopMost=true }) {
                owner.Show(); owner.Activate();
                int result = dialog.Show(owner.Handle);
                if (result == unchecked((int)0x800704C7)) { Console.Write("{\"cancelled\":true,\"path\":null}"); return 0; }
                Marshal.ThrowExceptionForHR(result);
                IShellItem item; dialog.GetResult(out item);
                try {
                    IntPtr value; item.GetDisplayName(0x80058000u, out value);
                    try { Console.Write(new JavaScriptSerializer().Serialize(new { cancelled=false, path=Marshal.PtrToStringUni(value) })); }
                    finally { Marshal.FreeCoTaskMem(value); }
                } finally { Marshal.ReleaseComObject(item); }
            }
            return 0;
        } catch (Exception error) { Console.Error.Write(error.Message); return 1; }
        finally { if (dialog != null) Marshal.ReleaseComObject(dialog); }
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=true)]
    static extern int SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, uint alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
}
