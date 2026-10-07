import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelSelection } from "../src/model-selection.js";

const models = [{ id: "big-pickle" }, { id: "gpt-5-nano" }];

test("sign-in replaces the signed-out automatic model with the authenticated default", () => {
  const initial = resolveModelSelection(
    { models, defaultModel: "big-pickle" },
    "",
    false,
  );
  const signedIn = resolveModelSelection(
    { models, defaultModel: "gpt-5-nano" },
    initial.modelId,
    initial.explicitlyChosen,
  );
  assert.equal(signedIn.modelId, "gpt-5-nano");
  assert.equal(signedIn.explicitlyChosen, false);
});

test("catalog and account changes preserve a deliberate model choice when still available", () => {
  const selected = resolveModelSelection(
    { models, defaultModel: "gpt-5-nano" },
    "big-pickle",
    true,
  );
  assert.deepEqual(selected, { modelId: "big-pickle", explicitlyChosen: true });
});

test("a model removed from the catalog falls back to the new default", () => {
  const selected = resolveModelSelection(
    { models: [{ id: "gpt-5-nano" }], defaultModel: "gpt-5-nano" },
    "big-pickle",
    true,
  );
  assert.deepEqual(selected, {
    modelId: "gpt-5-nano",
    explicitlyChosen: false,
  });
});
