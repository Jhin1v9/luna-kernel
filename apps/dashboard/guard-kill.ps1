param([int]$Me = 0)
# Guarda de instancia unica: mata qualquer node luna-server.js exceto $Me
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like '*luna-server.js*' -and $_.ProcessId -ne $Me -and $_.CommandLine -notlike '*fix-*'
} | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output ("matou: " + $_.ProcessId) }
  catch { Write-Output ("falhou: " + $_.ProcessId) }
}
