<#
  start-bot.ps1 - keeps the Kick Screenshot Bot running.

  The "Kick Screenshot Bot" scheduled task runs this script every time you
  log in to Windows (through start-bot-hidden.vbs, so no window appears).
  You can also run it by hand from this folder:

      powershell -ExecutionPolicy Bypass -File start-bot.ps1

  What it does:
    * runs from this folder (the bot reads .env and writes bot.lock here)
    * removes a stale bot.lock; waits if another bot instance is running
    * starts   node dist\index.js   and writes its output to logs\bot.log
      with a timestamp on every line
    * restarts the bot if it crashes (after 10 s, or 60 s if it died at once)
    * moves logs\bot.log to logs\bot.prev.log once it passes 10 MB
    * stops the bot (and its ffmpeg helpers) when the scheduled task is ended
#>

$ErrorActionPreference = 'Continue'

$root        = $PSScriptRoot
$logDir      = Join-Path $root 'logs'
$log         = Join-Path $logDir 'bot.log'
$prevLog     = Join-Path $logDir 'bot.prev.log'
$botLock     = Join-Path $root 'bot.lock'
$launchLock  = Join-Path $logDir 'launcher.lock'
$maxLogBytes = 10MB

$crashDelaySec     = 10   # bot ran for a while, then died
$fastCrashDelaySec = 60   # bot died within 30 s of starting (bad .env, no network, ...)
$lockWaitSec       = 60   # another bot instance holds bot.lock

# ------------------------------------------------------------ log writer --
# The launcher owns the log file and opens it with read/write sharing, so you
# can open logs\bot.log in Notepad while the bot is running.

$script:logStream   = $null
$script:logWriter   = $null
$script:lastRotate  = [DateTime]::MinValue

function Open-Log {
    $script:logStream = New-Object System.IO.FileStream($log, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
    $script:logWriter = New-Object System.IO.StreamWriter($script:logStream, (New-Object System.Text.UTF8Encoding($false)))
    $script:logWriter.AutoFlush = $true
}

function Close-Log {
    try { if ($script:logWriter) { $script:logWriter.Dispose() } } catch { }
    $script:logWriter = $null
    $script:logStream = $null
}

function Rotate-Log {
    # Try at most once a minute, so a failing move cannot spam the log.
    if (((Get-Date) - $script:lastRotate).TotalSeconds -lt 60) { return }
    $script:lastRotate = Get-Date
    Close-Log
    try { Move-Item -LiteralPath $log -Destination $prevLog -Force } catch { }
    Open-Log
    Write-Log 'previous log moved to logs\bot.prev.log'
}

function Write-Line([string] $text) {
    try {
        if (-not $script:logWriter) { Open-Log }
        $script:logWriter.WriteLine(('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text))
        if ($script:logStream.Length -gt $maxLogBytes) { Rotate-Log }
    } catch { }
}

function Write-Log([string] $message) { Write-Line "launcher: $message" }

# ---------------------------------------------------------------- helpers --

# Returns the live process that owns a PID lock file, or $null (missing/stale lock).
function Get-LockOwner([string] $path, [string] $expectedName) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $raw = ''
    try { $raw = [string](Get-Content -LiteralPath $path -Raw -ErrorAction Stop) } catch { return $null }
    $lockPid = 0
    if (-not [int]::TryParse($raw.Trim(), [ref] $lockPid) -or $lockPid -le 0 -or $lockPid -eq $PID) { return $null }
    $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq $expectedName) { return $proc }
    return $null
}

# The bot (node.exe) is a child of this launcher; its ffmpeg helpers are children of node.
# (The launcher's own hidden console host, conhost.exe, is a child too and must be left alone.)
function Get-BotChildren {
    try { return @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $PID AND Name = 'node.exe'") } catch { return @() }
}

function Stop-ProcessTree([int] $id) {
    try { Get-CimInstance Win32_Process -Filter "ParentProcessId = $id" | ForEach-Object { Stop-ProcessTree $_.ProcessId } } catch { }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

function Stop-BotChildren {
    foreach ($child in Get-BotChildren) { Stop-ProcessTree $child.ProcessId }
}

# When started by the scheduled task our parent is wscript.exe. If that parent
# disappears, the task was ended in Task Scheduler, so we must stop as well.
$taskParent = $null
try {
    $parentId = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
    $candidate = Get-Process -Id $parentId -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.ProcessName -eq 'wscript') { $taskParent = $candidate }
} catch { }

function Test-ShouldStop {
    return ($taskParent -ne $null -and $taskParent.HasExited)
}

# Sleeps in small steps so an "End task" is noticed quickly. $false = stop requested.
function Wait-Seconds([int] $seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ShouldStop) { return $false }
        Start-Sleep -Seconds 2
    }
    return -not (Test-ShouldStop)
}

# A Windows job object with "kill on close": every process we start (node,
# ffmpeg) joins it, and when this launcher exits for ANY reason the OS kills them.
$jobSource = @'
using System;
using System.Runtime.InteropServices;
public static class KickBotJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
                     ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
    }
    static IntPtr job = IntPtr.Zero;   // kept open on purpose: closing it kills the job
    public static string Setup() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return "CreateJobObject failed: " + Marshal.GetLastWin32Error();
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr ptr = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, 9, ptr, (uint)len))   // JobObjectExtendedLimitInformation
                return "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
        } finally { Marshal.FreeHGlobal(ptr); }
        if (!AssignProcessToJobObject(job, System.Diagnostics.Process.GetCurrentProcess().Handle))
            return "AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error();
        return "ok";
    }
}
'@

# ------------------------------------------------------------------- main --

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location -LiteralPath $root

$otherLauncher = Get-LockOwner $launchLock 'powershell'
if ($otherLauncher) {
    Write-Log "another launcher is already running (PID $($otherLauncher.Id)) - this one exits"
    Close-Log
    exit 0
}
Set-Content -LiteralPath $launchLock -Value $PID -Encoding ASCII

$startedBy = if ($taskParent) { 'scheduled task' } else { 'command line' }
Write-Log "launcher started (PID $PID, from the $startedBy)"

try {
    Add-Type -TypeDefinition $jobSource -ErrorAction Stop
    $jobResult = [KickBotJob]::Setup()
    if ($jobResult -ne 'ok') { Write-Log "WARNING: job object not available ($jobResult); the bot may outlive the launcher" }
} catch {
    Write-Log "WARNING: job object not available ($($_.Exception.Message)); the bot may outlive the launcher"
}

# Node prints UTF-8; decode it as such so the log keeps its symbols.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Tasks sometimes start with a reduced PATH; merge the machine and user PATH so
# node.exe and ffmpeg.exe are found wherever they were installed.
$env:Path = (@($env:Path,
               [Environment]::GetEnvironmentVariable('Path', 'Machine'),
               [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';'

# While the bot runs, this script is busy reading its output, so a small
# background thread watches the task's wrapper process and kills the bot when
# the task is ended; that returns control to the loop below, which then exits.
$watcher = $null
if ($taskParent) {
    try {
        $watcher = [powershell]::Create()
        [void] $watcher.AddScript({
            param($parent, $launcherPid)
            function Stop-Tree([int] $id) {
                try { Get-CimInstance Win32_Process -Filter "ParentProcessId = $id" | ForEach-Object { Stop-Tree $_.ProcessId } } catch { }
                Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
            }
            while (-not $parent.HasExited) { Start-Sleep -Seconds 2 }
            # Only the bot (node.exe) and what it started; never the launcher's own conhost.exe.
            Get-CimInstance Win32_Process -Filter "ParentProcessId = $launcherPid AND Name = 'node.exe'" |
                ForEach-Object { Stop-Tree $_.ProcessId }
        }).AddArgument($taskParent).AddArgument($PID)
        [void] $watcher.BeginInvoke()
    } catch {
        Write-Log "WARNING: could not start the end-task watcher ($($_.Exception.Message))"
    }
}

try {
    while ($true) {
        if (Test-ShouldStop) { Write-Log 'scheduled task was ended - stopping'; break }

        $owner = Get-LockOwner $botLock 'node'
        if ($owner) {
            Write-Log "another bot instance is already running (PID $($owner.Id)) - checking again in $lockWaitSec s"
            if (-not (Wait-Seconds $lockWaitSec)) { continue }
            continue
        }
        if (Test-Path -LiteralPath $botLock) {
            Write-Log 'removing stale bot.lock (its process is gone)'
            Remove-Item -LiteralPath $botLock -Force -ErrorAction SilentlyContinue
        }

        if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.js'))) {
            Write-Log "dist\index.js is missing - run 'npm run build' in this folder. Checking again in 60 s"
            if (-not (Wait-Seconds 60)) { continue }
            continue
        }
        $nodeExe   = (Get-Command node.exe   -ErrorAction SilentlyContinue).Source
        $ffmpegExe = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) {
            Write-Log 'node.exe was not found on PATH - install Node.js. Checking again in 60 s'
            if (-not (Wait-Seconds 60)) { continue }
            continue
        }
        if (-not $ffmpegExe) { Write-Log 'WARNING: ffmpeg.exe was not found on PATH - captures will fail' }

        Write-Log "starting bot: node dist\index.js   (node: $nodeExe; ffmpeg: $(if ($ffmpegExe) { $ffmpegExe } else { 'missing' }))"
        $started = Get-Date

        # Runs the bot and copies every line it prints (stdout and stderr) into the log.
        & $nodeExe 'dist\index.js' 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Line $_.Exception.Message }
            else { Write-Line ([string] $_) }
        }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = -1 }
        $ranSec = [int] ((Get-Date) - $started).TotalSeconds

        if (Test-ShouldStop) { Write-Log 'scheduled task was ended - bot stopped'; break }

        Write-Log "bot exited with code $code after $ranSec s"
        if ($code -eq 0) { Write-Log 'clean exit - launcher stopping'; break }
        $delay = if ($ranSec -lt 30) { $fastCrashDelaySec } else { $crashDelaySec }
        Write-Log "restarting in $delay s"
        if (-not (Wait-Seconds $delay)) { continue }
    }
} finally {
    # Give a bot that is still shutting down (Ctrl+C reaches it too) a moment, then force it.
    $deadline = (Get-Date).AddSeconds(3)
    while ((Get-BotChildren).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Stop-BotChildren
    if ($watcher) { try { $watcher.Stop(); $watcher.Dispose() } catch { } }
    Remove-Item -LiteralPath $launchLock -Force -ErrorAction SilentlyContinue
    Write-Log 'launcher stopped'
    Close-Log
}
