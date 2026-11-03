"""Owned process-tree lifetime; Windows Job Objects close on host exit/crash."""
import os
import subprocess


class ProcessUncertain(RuntimeError):
    pass


def attach(process):
    if os.name != "nt":
        return
    import ctypes as c
    from ctypes import wintypes as w
    class Basic(c.Structure):
        _fields_ = [("PerProcessUserTimeLimit", c.c_longlong), ("PerJobUserTimeLimit", c.c_longlong),
                    ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", c.c_size_t), ("MaximumWorkingSetSize", c.c_size_t),
                    ("ActiveProcessLimit", w.DWORD), ("Affinity", c.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]
    class IO(c.Structure):
        _fields_ = [(name, c.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
    class Extended(c.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IO), ("ProcessMemoryLimit", c.c_size_t),
                    ("JobMemoryLimit", c.c_size_t), ("PeakProcessMemoryUsed", c.c_size_t), ("PeakJobMemoryUsed", c.c_size_t)]
    kernel = c.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes, kernel.CreateJobObjectW.restype = [c.c_void_p, w.LPCWSTR], w.HANDLE
    kernel.SetInformationJobObject.argtypes, kernel.SetInformationJobObject.restype = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL
    kernel.AssignProcessToJobObject.argtypes, kernel.AssignProcessToJobObject.restype = [w.HANDLE, w.HANDLE], w.BOOL
    kernel.TerminateJobObject.argtypes, kernel.TerminateJobObject.restype = [w.HANDLE, w.UINT], w.BOOL
    kernel.CloseHandle.argtypes, kernel.CloseHandle.restype = [w.HANDLE], w.BOOL
    job = kernel.CreateJobObjectW(None, None)
    settings = Extended()
    settings.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    try:
        if not job or not kernel.SetInformationJobObject(job, 9, c.byref(settings), c.sizeof(settings)):
            raise c.WinError(c.get_last_error())
        if not kernel.AssignProcessToJobObject(job, w.HANDLE(int(process._handle))):
            raise c.WinError(c.get_last_error())
        process._research_job = (kernel, job)
    except BaseException:
        process.kill()
        process.wait(timeout=10)
        if job:
            kernel.CloseHandle(job)
        raise


def close_job(process):
    record = getattr(process, "_research_job", None)
    if record:
        kernel, job = record
        kernel.CloseHandle(job)
        process._research_job = None


def stop(process):
    record = getattr(process, "_research_job", None)
    if record:
        kernel, job = record
        if not kernel.TerminateJobObject(job, 1):
            raise ProcessUncertain("Cannot terminate owned Windows process tree")
    elif process.poll() is None:
        if os.name == "nt":
            raise ProcessUncertain("Process has no owned Job Object; manual reconciliation required")
        import signal
        os.killpg(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        raise ProcessUncertain("Could not confirm executor exit; recovery/reconciliation required")
    finally:
        close_job(process)
