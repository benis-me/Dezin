import { expect, test } from "vitest";
import { modelTextToIds, parseModelEntries, serializeModelEntries } from "./model-provider-ui-utils.tsx";

test("model provider entries keep legacy model id lines compatible", () => {
  expect(modelTextToIds("gpt-4o\n gpt-image-1 ")).toEqual(["gpt-4o", "gpt-image-1"]);
  expect(parseModelEntries("gpt-4o")).toEqual([{ id: "gpt-4o" }]);
});

test("model provider entries preserve display names and capabilities", () => {
  const serialized = serializeModelEntries([
    { id: "gpt-image-1", name: "GPT Image 1", capabilities: ["Image", "Vision"] },
    { id: "claude-sonnet-4-6" },
  ]);

  expect(modelTextToIds(serialized)).toEqual(["gpt-image-1", "claude-sonnet-4-6"]);
  expect(parseModelEntries(serialized)[0]).toEqual({ id: "gpt-image-1", name: "GPT Image 1", capabilities: ["Image", "Vision"] });
});
