# Test script for conversation window feature (10 seconds)

$API_URL = "http://192.168.1.38:8090"
$API_KEY = $env:JARVIS_API_KEY

# Generate a unique thread ID for this test
$THREAD_ID = "test-$(Get-Date -UFormat %s)-$PID"
Write-Host "🧪 Testing conversation window with threadId: $THREAD_ID" -ForegroundColor Cyan
Write-Host ""

# Test 1: First request
Write-Host "[1/3] First request (should create new thread)..." -ForegroundColor Yellow
$body1 = @{
    text = "Quelle est la météo?"
    threadId = $THREAD_ID
    channel = "test"
} | ConvertTo-Json

$response1 = curl.exe -s -X POST "$API_URL/v1/ingest" `
  -H "Content-Type: application/json" `
  $(if ($API_KEY) { "-H", "X-API-Key: $API_KEY" }) `
  -d $body1

$json1 = $response1 | ConvertFrom-Json -ErrorAction SilentlyContinue
$threadId1 = $json1.threadId
Write-Host "  Response threadId: $threadId1" -ForegroundColor Gray
Write-Host "  First 80 chars: $($json1.responseText.Substring(0, [Math]::Min(80, $json1.responseText.Length)))" -ForegroundColor Gray
Start-Sleep -Seconds 1

# Test 2: Immediate follow-up within 10s window
Write-Host ""
Write-Host "[2/3] Immediate follow-up within 10s window..." -ForegroundColor Yellow
$body2 = @{
    text = "Et demain?"
    threadId = $THREAD_ID
    channel = "test"
} | ConvertTo-Json

$response2 = curl.exe -s -X POST "$API_URL/v1/ingest" `
  -H "Content-Type: application/json" `
  $(if ($API_KEY) { "-H", "X-API-Key: $API_KEY" }) `
  -d $body2

$json2 = $response2 | ConvertFrom-Json -ErrorAction SilentlyContinue
$threadId2 = $json2.threadId
Write-Host "  Response threadId: $threadId2" -ForegroundColor Gray
Write-Host "  First 80 chars: $($json2.responseText.Substring(0, [Math]::Min(80, $json2.responseText.Length)))" -ForegroundColor Gray
Start-Sleep -Seconds 1

# Test 3: After 10s window expires
Write-Host ""
Write-Host "[3/3] Waiting 11s for window to expire..." -ForegroundColor Yellow
for ($i = 11; $i -ge 1; $i--) {
    Write-Host -NoNewline "`r  Remaining: ${i}s   "
    Start-Sleep -Seconds 1
}
Write-Host ""

$body3 = @{
    text = "Comment est le vent?"
    threadId = $THREAD_ID
    channel = "test"
} | ConvertTo-Json

$response3 = curl.exe -s -X POST "$API_URL/v1/ingest" `
  -H "Content-Type: application/json" `
  $(if ($API_KEY) { "-H", "X-API-Key: $API_KEY" }) `
  -d $body3

$json3 = $response3 | ConvertFrom-Json -ErrorAction SilentlyContinue
$threadId3 = $json3.threadId
Write-Host "  Response threadId: $threadId3" -ForegroundColor Gray
Write-Host "  First 80 chars: $($json3.responseText.Substring(0, [Math]::Min(80, $json3.responseText.Length)))" -ForegroundColor Gray

# Analyze results
Write-Host ""
Write-Host "📊 Test Results:" -ForegroundColor Cyan
Write-Host "  Request 1 threadId: $threadId1"
Write-Host "  Request 2 threadId: $threadId2"
Write-Host "  Request 3 threadId: $threadId3"
Write-Host ""

if ($threadId1 -eq $threadId2) {
    Write-Host "✅ Request 2 reused thread (window active)" -ForegroundColor Green
} else {
    Write-Host "❌ Request 2 did NOT reuse thread" -ForegroundColor Red
}

if ($threadId2 -ne $threadId3 -or $threadId1 -ne $threadId3) {
    Write-Host "✅ Request 3 created new thread (window expired)" -ForegroundColor Green
} else {
    Write-Host "❌ Request 3 did NOT create new thread" -ForegroundColor Red
}

# Show relevant logs
Write-Host ""
Write-Host "📜 Recent logs mentioning conversation window:" -ForegroundColor Cyan
$logs = ssh loic@192.168.1.38 "docker logs home-assistant-jarvis-1 2>&1 | grep -E 'ingest_reusing_active_thread|ingest_complete' | tail -10"
Write-Host $logs
