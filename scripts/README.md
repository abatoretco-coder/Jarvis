# Jarvis Scripts Index

Only scripts used by package commands, runtime deployment, container assembly, or current operational documentation are kept.

## Integrated Scripts

- check-capabilities.ts: Used by `npm run check:capabilities`.
- oauth-helper.ts: Used by `npm run oauth:*` helpers.
- generate-api-keys.ts: Used by `npm run tokens:generate`.
- conversation-db.ts: Used by `npm run db:conversation`.
- preview-replies.ts: Used by `npm run preview:replies`.
- evaluate-openai-capabilities.ts: Used by `npm run eval:openai:capabilities`.
- evaluate-openai-audio.ts: Used by `npm run eval:openai:audio`.
- evaluate-semantic-router.ts: Offline evaluation of Semantic Router against versioned routing fixtures. Used by `npm run eval:routing`.
- verify-music-routing.ts: Used by `npm run verify:music-routing`.
- run-prod-voice-music-e2e.ts: Explicit authenticated production voice/music checks.
- run-prod-home-e2e.ts: Explicit authenticated production home checks.
- run-prod-lighting-e2e.ts: Explicit authenticated production lighting checks.
- pc-runtime.ps1: Used by `npm run pc` and `npm run backup:pc`.
- https-runtime.ps1, startup-runtime.ps1, pc-agent-runtime.ps1, update-duckdns.ps1: PC runtime and HTTPS startup operations documented in `docs/HTTPS_PC_DEPLOYMENT.md`.
- validate-edge-config.ps1 and scan-runtime-image.ps1: Security validation commands exposed by `package.json`.
- protect-local-secrets.ps1: Applies Windows ACLs to local runtime secrets.
- generate-home-plan-assets.mjs and evaluate-flash-info.mjs: Build/runtime assets copied by the container image.
