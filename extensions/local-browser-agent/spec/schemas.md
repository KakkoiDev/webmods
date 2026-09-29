# Schemas

These are the canonical logical schemas. TypeScript interfaces and runtime validation should be generated/implemented from these contracts rather than inventing parallel shapes.

## Observation

```ts
interface Observation {
  id: string;
  url: string;
  title: string;
  nodes: ObservedNode[];
  capturedAt: number;
}

interface ObservedNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled: boolean;
  checked?: boolean;
  selected?: boolean;
}
```

## Goal and decision

```ts
interface AgentRequest {
  goal: string;
  maxActions: number; // default 10
}

type ActionKind = "click" | "type" | "scroll" | "select" | "navigate" | "wait" | "finish";

interface Decision {
  action: ActionKind;
  target?: string;       // observation ref
  text?: string;         // type/navigate/select payload
  confidence: number;    // normalized 0..1
  reason?: string;       // short diagnostic, not hidden reasoning
}
```

Laya should receive a closed choice set constructed from legal actions and current refs. The deterministic adapter rejects any target not present in the current observation.

## Action result

```ts
interface ActionResult {
  ok: boolean;
  observationId: string;
  action: ActionKind;
  target?: string;
  changed: boolean;
  error?: "stale_ref" | "not_found" | "disabled" | "blocked" | "timeout";
}
```

## Confirmation

```ts
type Risk = "safe" | "sensitive" | "destructive";

interface ConfirmationRequest {
  risk: Risk;
  action: Decision;
  summary: string;
}
```

v1 policy: `safe` may execute; `sensitive` and `destructive` require explicit confirmation. A model cannot lower the deterministic risk classification.

## Model descriptor

```ts
interface ModelDescriptor {
  id: string;
  role: "decision" | "text";
  revision: string;
  runtime: "onnx-wasm" | "webgpu";
  files: { url: string; sha256?: string; bytes?: number }[];
}

type ModelState = "missing" | "downloading" | "cached" | "loading" | "ready" | "error";
```

Credentials and page data are never part of a model descriptor.
