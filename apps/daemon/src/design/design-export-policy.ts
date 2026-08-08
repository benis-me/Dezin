export const DESIGN_EXPORT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "worker-src 'none'",
].join("; ");
