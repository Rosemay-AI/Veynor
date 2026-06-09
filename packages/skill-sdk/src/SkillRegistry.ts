import type { Skill } from "./Skill.js";

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private _defaultId: string | null = null;

  register(skill: Skill): void {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill "${skill.id}" is already registered`);
    }
    this.skills.set(skill.id, skill);
    if (this._defaultId === null) {
      this._defaultId = skill.id;
    }
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  unregister(id: string): boolean {
    const removed = this.skills.delete(id);
    if (removed && this._defaultId === id) {
      this._defaultId = this.skills.keys().next().value ?? null;
    }
    return removed;
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  ids(): string[] {
    return [...this.skills.keys()];
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  get defaultId(): string | null {
    return this._defaultId;
  }

  setDefault(id: string): void {
    if (!this.skills.has(id)) {
      throw new Error(`Skill "${id}" is not registered`);
    }
    this._defaultId = id;
  }

  get size(): number {
    return this.skills.size;
  }
}

const globalRegistry = new SkillRegistry();

export function registerSkill(skill: Skill): void {
  globalRegistry.register(skill);
}

export function getSkill(id: string): Skill | undefined {
  return globalRegistry.get(id);
}

export const skills: SkillRegistry = globalRegistry;