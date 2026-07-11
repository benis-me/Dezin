import { expect, test } from "vitest";
import { isImeComposing, isReservedShortcutTarget } from "./keyboard.ts";

test("isImeComposing recognizes native and synthetic composition state", () => {
  expect(isImeComposing({ isComposing: true })).toBe(true);
  expect(isImeComposing({ nativeEvent: { isComposing: true } })).toBe(true);
  expect(isImeComposing({ isComposing: false, nativeEvent: { isComposing: false } })).toBe(false);
});

test("isReservedShortcutTarget protects native controls, links, and interactive roles", () => {
  const nestedButton = document.createElement("span");
  nestedButton.innerHTML = "<button><span data-target>Action</span></button>";
  const buttonTarget = nestedButton.querySelector("[data-target]");
  const role = document.createElement("div");
  role.innerHTML = '<div role="slider"><span data-target></span></div>';
  const roleTarget = role.querySelector("[data-target]");

  expect(isReservedShortcutTarget(document.createElement("input"))).toBe(true);
  expect(isReservedShortcutTarget(document.createElement("textarea"))).toBe(true);
  expect(isReservedShortcutTarget(document.createElement("select"))).toBe(true);
  expect(isReservedShortcutTarget(document.createElement("button"))).toBe(true);
  expect(isReservedShortcutTarget(document.createElement("a"))).toBe(true);
  expect(isReservedShortcutTarget(buttonTarget)).toBe(true);
  expect(isReservedShortcutTarget(roleTarget)).toBe(true);
  expect(isReservedShortcutTarget(document.createElement("div"))).toBe(false);
});
