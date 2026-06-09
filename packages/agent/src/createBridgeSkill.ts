import type { VeynorSkillInternalOptions } from "./types.js";
import { BridgeSkill } from "./BridgeSkill.js";

export function createBridgeSkill(options: VeynorSkillInternalOptions): BridgeSkill {
  return new BridgeSkill(options);
}
