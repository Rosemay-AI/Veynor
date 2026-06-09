import type { Signal } from "./Signal.js";

export type EdgeTransform = (signal: Signal) => Signal | Signal[] | null;

export type EdgeCondition = (signal: Signal) => boolean;

export interface EdgeEndpoint {
  readonly nodeId: string;
  readonly portId: string;
}

export interface Edge {
  readonly id: string;
  readonly from: EdgeEndpoint;
  readonly to: EdgeEndpoint;
  readonly transform?: EdgeTransform;
  readonly condition?: EdgeCondition;
}

export function edge(
  id: string,
  fromNode: string,
  fromPort: string,
  toNode: string,
  toPort: string,
  opts?: {
    transform?: EdgeTransform;
    condition?: EdgeCondition;
  }
): Edge {
  return {
    id,
    from: { nodeId: fromNode, portId: fromPort },
    to: { nodeId: toNode, portId: toPort },
    ...(opts?.transform ? { transform: opts.transform } : {}),
    ...(opts?.condition ? { condition: opts.condition } : {}),
  };
}
