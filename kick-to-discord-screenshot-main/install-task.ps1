<#
  install-task.ps1 - registers (or updates) the "Kick Screenshot Bot" scheduled
  task so the bot starts in the background every time you log in to Windows,
  then starts it right away. No admin rights needed. Run it from this folder:

      powershell -ExecutionPolicy Bypass -File install-task.ps1

  Remove the task again with:

      schtasks /Delete /TN "Kick Screenshot Bot" /F
#>

$ErrorActionPreference = 'Stop'

$taskName = 'Kick Screenshot Bot'
$root     = $PSScriptRoot
$user     = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path -LiteralPath (Join-Path $root 'start-bot-hidden.vbs'))) {
    throw "start-bot-hidden.vbs not found next to this script ($root)"
}

# wscript runs start-bot-hidden.vbs, which runs start-bot.ps1 with no window.
$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument "//B //Nologo `"$root\start-bot-hidden.vbs`"" -WorkingDirectory $root

# 30 s after this user logs in (gives Wi-Fi/network a moment to come up).
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -Compatibility Win8

# "Run only when user is logged on": needs no password and no admin rights.
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$description = 'Starts the Kick Screenshot Bot (node dist\index.js) in the background at login and keeps it running. ' +
               'Output: logs\bot.log in the project folder. Launcher: start-bot.ps1. ' +
               'Remove with: schtasks /Delete /TN "Kick Screenshot Bot" /F'

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Description $description -Force | Out-Null
Write-Host "Task '$taskName' is installed: it starts the bot 30 s after you log in."

Start-ScheduledTask -TaskName $taskName
Write-Host "The bot is starting now. Watch logs\bot.log in $root"
Write-Host "Stop it any time with:  schtasks /End /TN `"$taskName`""
