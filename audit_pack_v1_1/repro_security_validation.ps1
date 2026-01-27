$ErrorActionPreference = 'Stop'

$baseUrl = $Env:BASE_URL
if (-not $baseUrl) { $baseUrl = 'http://localhost:3000' }
$token = $Env:TOKEN
$tokenNoAck = $Env:TOKEN_NO_ACK
$escalationId = $Env:ESCALATION_ID

function Get-Status($method, $url, $headers, $body) {
  try {
    if ($body) {
      Invoke-WebRequest -Method $method -Uri $url -Headers $headers -Body $body -ContentType 'application/json' -UseBasicParsing | Out-Null
    } else {
      Invoke-WebRequest -Method $method -Uri $url -Headers $headers -UseBasicParsing | Out-Null
    }
    return 200
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.StatusCode) {
      return $resp.StatusCode.value__
    }
    return 0
  }
}

function Check($name, $expected, $actual) {
  if ($expected -eq $actual) {
    Write-Host "PASS: $name (expected=$expected got=$actual)" -ForegroundColor Green
  } else {
    Write-Host "FAIL: $name (expected=$expected got=$actual)" -ForegroundColor Red
  }
}

Write-Host "BASE_URL=$baseUrl"
if (-not $token) { Write-Host 'WARN: TOKEN is empty; set $Env:TOKEN' -ForegroundColor Yellow }
if (-not $tokenNoAck) { Write-Host 'WARN: TOKEN_NO_ACK is empty; set $Env:TOKEN_NO_ACK' -ForegroundColor Yellow }
if (-not $escalationId) { Write-Host 'WARN: ESCALATION_ID is empty; set $Env:ESCALATION_ID' -ForegroundColor Yellow }

# 1) 401 missing token
$code = Get-Status 'GET' "$baseUrl/api/care-pulse/state" @{} $null
Check '401 missing token' 401 $code

# 2) 200 with token
$code = Get-Status 'GET' "$baseUrl/api/care-pulse/state" @{ Authorization = "Bearer $token" } $null
Check '200 with token' 200 $code

# 3) 400 invalid UUID
$body = @{ event_type='CHECK_IN'; event_id='not-a-uuid'; client_ts=123; client_tz='Asia/Bangkok'; ui_session_id='u1'; source='manual'; self_report='NORMAL' } | ConvertTo-Json
$code = Get-Status 'POST' "$baseUrl/api/care-pulse/events" @{ Authorization = "Bearer $token" } $body
Check '400 invalid UUID' 400 $code

# 4) 400 invalid type
$body = @{ addressee_id='abc' } | ConvertTo-Json
$code = Get-Status 'POST' "$baseUrl/api/care-circle/invitations" @{ Authorization = "Bearer $token" } $body
Check '400 invalid type' 400 $code

# 5) 403 ack without permission
if ($tokenNoAck -and $escalationId) {
  $body = @{ escalation_id=$escalationId } | ConvertTo-Json
  $code = Get-Status 'POST' "$baseUrl/api/care-pulse/escalations/ack" @{ Authorization = "Bearer $tokenNoAck" } $body
  Check '403 ack missing permission' 403 $code
} else {
  Write-Host 'SKIP: 403 ack missing permission (TOKEN_NO_ACK or ESCALATION_ID not set)' -ForegroundColor Yellow
}

# 6) 200 ack with permission
if ($token -and $escalationId) {
  $body = @{ escalation_id=$escalationId } | ConvertTo-Json
  $code = Get-Status 'POST' "$baseUrl/api/care-pulse/escalations/ack" @{ Authorization = "Bearer $token" } $body
  Check '200 ack with permission' 200 $code
} else {
  Write-Host 'SKIP: 200 ack with permission (TOKEN or ESCALATION_ID not set)' -ForegroundColor Yellow
}
