' Starts start-bot.ps1 with no window. The "Kick Screenshot Bot" scheduled task
' runs this at login; you can also double-click it to start the bot by hand.
' To stop the bot, end the task in Task Scheduler (see README.md).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & dir & "\start-bot.ps1"""
WScript.Quit CreateObject("WScript.Shell").Run(cmd, 0, True)
