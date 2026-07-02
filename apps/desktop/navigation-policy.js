function parseAbsoluteUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isSafeExternalUrl(value) {
  const url = parseAbsoluteUrl(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}

function isAllowedAppNavigation(targetUrl, appUrl) {
  const target = parseAbsoluteUrl(targetUrl);
  const app = parseAbsoluteUrl(appUrl);
  if (!target || !app) return false;
  return target.origin === app.origin;
}

module.exports = {
  isAllowedAppNavigation,
  isSafeExternalUrl,
};
