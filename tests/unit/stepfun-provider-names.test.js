/**
 * StepFun channel display names.
 *
 * The four channels are Domestic/International × Pay-as-you-go/Step Plan, and the
 * plan ones originally read "StepFun Step Plan" / "StepFun CN Step Plan" — which
 * stutters, since "StepFun" already contains "Step". They are the plan variants of
 * the two pay-as-you-go channels and now say so directly: `<channel> Plan`.
 *
 * Pinned here because the name is the only thing distinguishing four cards that
 * share a logo and an almost identical model list, and a careless edit would
 * collapse two of them into the same label.
 */
import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";

const CHANNELS = ["stepfun", "stepfun-cn", "stepfun-plan", "stepfun-plan-cn"];
const nameOf = (id) => REGISTRY.find((r) => r.id === id)?.display?.name;

describe("StepFun provider display names", () => {
  it("uses the short product names", () => {
    expect(nameOf("stepfun")).toBe("StepFun");
    expect(nameOf("stepfun-cn")).toBe("StepFun CN");
    expect(nameOf("stepfun-plan")).toBe("StepFun Plan");
    expect(nameOf("stepfun-plan-cn")).toBe("StepFun CN Plan");
  });

  it("drops the redundant 'Step' from the plan channels", () => {
    expect(nameOf("stepfun-plan")).not.toContain("Step Plan");
    expect(nameOf("stepfun-plan-cn")).not.toContain("Step Plan");
  });

  it("names each plan channel after its pay-as-you-go sibling", () => {
    expect(nameOf("stepfun-plan")).toBe(`${nameOf("stepfun")} Plan`);
    expect(nameOf("stepfun-plan-cn")).toBe(`${nameOf("stepfun-cn")} Plan`);
  });

  it("keeps all four channels distinguishable", () => {
    const names = CHANNELS.map(nameOf);
    expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(CHANNELS.length);
  });
});
