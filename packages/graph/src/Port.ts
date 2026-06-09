import type { SignalType } from "./Signal.js";

export type PortDirection = "input" | "output";

export interface Port {
  readonly id: string;
  readonly direction: PortDirection;
  readonly accepts: SignalType[];
  readonly required: boolean;
  readonly name?: string;
}

export function inputPort(
  id: string,
  accepts: SignalType[],
  opts?: { required?: boolean; name?: string }
): Port {
  return {
    id,
    direction: "input",
    accepts,
    required: opts?.required ?? true,
    name: opts?.name,
  };
}

export function outputPort(
  id: string,
  accepts: SignalType[],
  opts?: { name?: string }
): Port {
  return {
    id,
    direction: "output",
    accepts,
    required: false,
    name: opts?.name,
  };
}
