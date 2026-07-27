const SENSITIVE_RESEARCH_URL_KEY =
  /(?:^|[-_.])(token|secret|password|passwd|api[-_]?key|authorization|auth|credential|signature|signed|session|jwt)(?:$|[-_.])/i;

const NORMALIZED_SENSITIVE_RESEARCH_URL_KEYS = new Set([
  "sig",
  "signed",
  "signedby",
  "signedheaders",
  "signedurl",
  "accesskeyid",
  "awsaccesskeyid",
  "googleaccessid",
  "keypairid",
  "xamzcredential",
  "xamzsignature",
  "xamzsignedheaders",
  "xgoogcredential",
  "xgoogsignature",
  "xgoogsignedheaders",
]);

function isSensitiveResearchUrlKey(key: string): boolean {
  const normalized = key
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[-_.\s]/gu, "");
  return SENSITIVE_RESEARCH_URL_KEY.test(key)
    || NORMALIZED_SENSITIVE_RESEARCH_URL_KEYS.has(normalized);
}

export function isCanonicalResearchHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && parsed.username === ""
    && parsed.password === ""
    && !value.includes("#")
    && parsed.hash === ""
    && parsed.href === value
    && ![...parsed.searchParams.keys()].some(isSensitiveResearchUrlKey);
}
