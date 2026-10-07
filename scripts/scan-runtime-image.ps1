param(
  [string]$ImageName = 'jarvis-phase8-check:local'
)

$ErrorActionPreference = 'Stop'

docker build --pull --tag $ImageName .
if ($LASTEXITCODE -ne 0) {
  throw "Docker build failed with exit code $LASTEXITCODE."
}

docker run --rm `
  --volume /var/run/docker.sock:/var/run/docker.sock `
  aquasec/trivy:0.75.0 image `
  --scanners vuln,secret `
  --severity HIGH,CRITICAL `
  --ignore-unfixed `
  --exit-code 1 `
  --quiet `
  $ImageName

if ($LASTEXITCODE -ne 0) {
  throw "Trivy found a fixed HIGH or CRITICAL vulnerability, a secret, or failed to scan."
}

