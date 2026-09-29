# Roadmap

## M0 — architecture and shell

- MV3 hand-authored extension in Web Mods.
- Toolbar/shortcut opens a minimal panel.
- Compact interactive DOM observation.
- Canonical schemas and diagrams.
- No pretend AI: model runtime clearly marked as not integrated.

## M1 — deterministic executor + tests

Implement `observe`, `click`, `type`, `scroll`, `select`, `navigate`, `wait`, `finish`. Add stale-ref protection, re-observation after mutations, action budget, risk classifier and confirmation UI.

Headless extension tests must cover at least ten fixture tasks, including SPA mutation, duplicate labels, disabled controls, forms, navigation, stale refs, iframes where permitted, confirmation gates, timeout and stop.

## M2 — browser-wide model manager

Add an offscreen model host and persistent cache. Verify model download once, reload/restart restoration, offline inference, progress, cancellation, unload/reload and unsupported-WebGPU fallback.

## M3 — Laya DecisionProvider

Run Laya locally via a browser-capable ONNX runtime. Preserve its required preprocessing/post-processing/calibration. Use typed choices for action/target and scores for confidence/risk-related signals. Benchmark latency and correctness against deterministic fixture tasks.

## M4 — Qwen TextProvider

Run Qwen3-0.6B locally, preferably WebGPU with a tested fallback where practical. Use it for language/planning only; DOM actions remain typed and validated.

## M5 — integrated local agent

Bounded observe -> decide -> validate -> execute -> observe loop. Offline acceptance test: after models are cached and network is disabled, complete ten distinct DOM tasks without cloud/native services.

## M6 — hardening

Prompt-injection fixtures, hostile DOM, hidden text, dynamic pages, shadow DOM, frames, downloads/uploads policy, accessibility-tree enrichment, model/version migrations, performance and memory budgets.
