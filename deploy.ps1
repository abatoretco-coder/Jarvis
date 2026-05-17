# Deploy script for Jarvis to VM400 (192.168.1.38)
param(
    [string]$HostIP = "192.168.1.38",
    [string]$User = "loic"
)

$ErrorActionPreference = "Stop"

Write-Host "🚀 Deploying Jarvis to $HostIP..." -ForegroundColor Cyan

# Step 1: Build locally
Write-Host "`n[1/4] Building locally..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed!" -ForegroundColor Red
    exit 1
}

# Step 2: Copy dist to remote
Write-Host "`n[2/4] Copying dist/ to remote (tar+SSH)..." -ForegroundColor Yellow
$RemoteJarvisPath = "/opt/naas/stacks/Jarvis"

# Create tar archive of dist/
Write-Host "   Creating tar archive..." -ForegroundColor Gray
tar -czf ".\dist.tar.gz" -C "." "dist" 2>&1 | Out-Null

# Transfer via SCP
Write-Host "   Transferring via SCP..." -ForegroundColor Gray
scp -q ".\dist.tar.gz" "${User}@${HostIP}:${RemoteJarvisPath}/"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ SCP transfer failed!" -ForegroundColor Red
    Remove-Item ".\dist.tar.gz" -Force
    exit 1
}

# Extract on remote
Write-Host "   Extracting on remote..." -ForegroundColor Gray
ssh ${User}@${HostIP} "cd ${RemoteJarvisPath} && tar -xzf dist.tar.gz && rm dist.tar.gz"

if ($LASTEXITCODE -ne 0) {
    Write-Host "⚠️  SCP warning, but continuing..." -ForegroundColor Yellow
}

# Clean up local tar
Remove-Item ".\dist.tar.gz" -Force

# Step 3: Restart Docker container
Write-Host "`n[3/4] Restarting Jarvis container on $HostIP..." -ForegroundColor Yellow
ssh ${User}@${HostIP} "cd /opt/naas/stacks/home-assistant && docker compose -f docker-compose.prod.yml restart jarvis 2>&1 | grep -v orphan"

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Docker restart failed!" -ForegroundColor Red
    exit 1
}

# Step 4: Wait for container to be healthy
Write-Host "`n[4/4] Waiting for Jarvis to be healthy (20s timeout)..." -ForegroundColor Yellow
$HealthCheck = ssh ${User}@${HostIP} "for i in {1..10}; do curl -s http://localhost:8090/health && exit 0 || sleep 2; done; exit 1"

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Jarvis is healthy!" -ForegroundColor Green
} else {
    Write-Host "⚠️  Health check timeout, but container may still be starting..." -ForegroundColor Yellow
}

Write-Host "`n✅ Deployment complete!" -ForegroundColor Green
Write-Host ("   Jarvis API: http://{0}:8090" -f $HostIP) -ForegroundColor Cyan
Write-Host ('   Check logs: ssh {0}@{1} ''docker logs -f home-assistant-jarvis-1 2>&1 | grep -E "ingest|conversation"''' -f $User, $HostIP) -ForegroundColor Cyan
