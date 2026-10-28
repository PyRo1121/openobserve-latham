# Latham Workers AI frontend

This branch starts at OpenObserve OSS v1.1.2, commit `d16d693ba99bc20621a58b948ecbcad7ec7fa882`.

It reuses the native assistant, history, context and AI monitoring components with a separately implemented, owner-authenticated Cloudflare Workers AI backend. The backend implements the native `/api/default/ai/chat_stream` SSE contract and advertises `ai_enabled` in the authenticated runtime configuration. The global Enterprise and Cloud build flags remain false. The stock Rust backend and its Enterprise-only features are unchanged.

The AI section adds a DeepSeek assistant route. A Web traffic tab embeds the owner-authenticated traffic/globe content inside the same application shell, follows the native theme, and removes duplicate navigation. The native header and home assistant respect backend availability. Welcome copy describes read-only data access. Unsupported attachment and feedback controls are hidden. When model pricing is disabled, AI monitoring reports unavailable cost rather than implying verified zero billing.

Build from `web/` with the checked-in dependency lockfile, `patch-package`, and:

```powershell
$env:VITE_OPENOBSERVE_ENTERPRISE='false'
$env:VITE_OPENOBSERVE_CLOUD='false'
$env:VITE_ZINC_ANALYTICS_ENABLED='false'
node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --base /_next/web/
```

The generated frontend can be served as private Cloudflare Worker assets; API requests continue to the existing OpenObserve container through the authenticated gateway. No Rust or container rebuild is required. Model credentials stay in the Worker binding, outside browser assets.

Modified source is available on this branch under the upstream AGPL license. This is an independent deployment and is not OpenObserve Enterprise or the upstream SRE Agent.
