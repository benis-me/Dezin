const test = require("node:test");
const assert = require("node:assert/strict");

const { isAllowedAppNavigation, isSafeExternalUrl } = require("../navigation-policy.js");

test("external URLs are limited to http and https", () => {
  assert.equal(isSafeExternalUrl("https://example.com/docs"), true);
  assert.equal(isSafeExternalUrl("http://example.com/docs"), true);

  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("file:///Users/ben/.ssh/id_rsa"), false);
  assert.equal(isSafeExternalUrl("mailto:hello@example.com"), false);
  assert.equal(isSafeExternalUrl("not a url"), false);
});

test("app navigation stays on the loaded app origin", () => {
  const appUrl = "http://127.0.0.1:7457/";

  assert.equal(isAllowedAppNavigation("http://127.0.0.1:7457/projects/p1", appUrl), true);
  assert.equal(isAllowedAppNavigation("http://127.0.0.1:5173/projects/p1", appUrl), false);
  assert.equal(isAllowedAppNavigation("https://example.com", appUrl), false);
  assert.equal(isAllowedAppNavigation("file:///tmp/preview.html", appUrl), false);
  assert.equal(isAllowedAppNavigation("not a url", appUrl), false);
});
