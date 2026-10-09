# Richtet den täglichen Verdichtungslauf als Windows-Aufgabe ein (21:30 Uhr, nachholen wenn der Rechner aus war).
# Entfernen: Unregister-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten' -Confirm:$false
$node = (Get-Command node).Source
$skript = Join-Path $PSScriptRoot 'sitzungen-verdichten.js'
$vault = Split-Path (Split-Path $PSScriptRoot)
$aktion = New-ScheduledTaskAction -Execute $node -Argument "`"$skript`" --ausfuehren --max 12" -WorkingDirectory $vault
$ausloeser = New-ScheduledTaskTrigger -Daily -At 21:30
$einst = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$prinzipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten' -Action $aktion -Trigger $ausloeser -Settings $einst -Principal $prinzipal `
  -Description 'Verdichtet Rohsitzungen des Wissens-Vaults (Claude headless, max 12 je Lauf).' -Force | Select-Object TaskName, State
Get-ScheduledTask -TaskName 'Brain-Sitzungen-verdichten' | Get-ScheduledTaskInfo | Select-Object NextRunTime
