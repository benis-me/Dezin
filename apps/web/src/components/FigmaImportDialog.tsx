import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Figma, KeyRound, LoaderCircle } from "lucide-react";
import {
  FIGMA_IMPORT_SCHEMA_VERSION,
  type FigmaCanvasImportResponse,
  type FigmaCredentialStatus,
  type FigmaImportAnchor,
} from "../design-canvas/types.ts";
import { ApiError } from "../lib/api.ts";
import { useApi } from "../lib/api-context.tsx";
import { hasFigmaVersionSelection, previewFigmaImportUrl } from "../lib/figma-import-url.ts";
import { Button, Dialog, Input } from "./ui/index.ts";

const FIGMA_PENDING_IMPORT_STORAGE_KEY = "dezin:figma-import-intent:v1";
const FIGMA_IMPORT_KEY = /^figma-[A-Za-z0-9._:-]{1,153}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function figmaImportKey(): string {
  return `figma-${typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

async function figmaImportFingerprint(fingerprint: string): Promise<string> {
  const bytes = new TextEncoder().encode(`dezin-figma-import-v1\0${fingerprint}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function pendingFigmaImportKey(fingerprint: string): Promise<string> {
  const fingerprintHash = await figmaImportFingerprint(fingerprint);
  try {
    const stored = JSON.parse(globalThis.localStorage.getItem(FIGMA_PENDING_IMPORT_STORAGE_KEY) ?? "null") as unknown;
    if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
      const record = stored as Record<string, unknown>;
      if (Object.keys(record).length === 2
        && typeof record.fingerprintHash === "string" && SHA256.test(record.fingerprintHash)
        && typeof record.key === "string" && FIGMA_IMPORT_KEY.test(record.key)
        && record.fingerprintHash === fingerprintHash) {
        return record.key;
      }
    }
  } catch {
    // localStorage is a best-effort renderer crash bridge; daemon idempotency remains authoritative.
  }
  const key = figmaImportKey();
  try {
    globalThis.localStorage.setItem(FIGMA_PENDING_IMPORT_STORAGE_KEY, JSON.stringify({ fingerprintHash, key }));
  } catch {
    // A private/disabled storage context still gets in-memory idempotency for this mounted dialog.
  }
  return key;
}

async function clearPendingFigmaImportKey(fingerprint: string, key: string): Promise<void> {
  const fingerprintHash = await figmaImportFingerprint(fingerprint);
  try {
    const stored = JSON.parse(globalThis.localStorage.getItem(FIGMA_PENDING_IMPORT_STORAGE_KEY) ?? "null") as unknown;
    if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
      const record = stored as Record<string, unknown>;
      if (record.fingerprintHash === fingerprintHash && record.key === key) {
        globalThis.localStorage.removeItem(FIGMA_PENDING_IMPORT_STORAGE_KEY);
      }
    }
  } catch {
    // Ignore unavailable or externally corrupted browser storage.
  }
}

function figmaImportError(problem: unknown): string {
  if (problem instanceof ApiError) {
    if (problem.status === 503) {
      return "Figma access isn't configured. Add a personal access token here or set FIGMA_ACCESS_TOKEN for the local daemon.";
    }
    if (problem.status === 409) return "This import request conflicts with an earlier attempt. Edit the link and try again.";
    if (problem.message.trim()) return problem.message;
  }
  return "Couldn't import this Figma file. Check the link and your Figma access, then try again.";
}

function wasAborted(problem: unknown): boolean {
  return problem instanceof DOMException && problem.name === "AbortError";
}

export function FigmaImportDialog({
  open,
  projectId,
  anchor,
  onClose,
  onImported,
  returnFocusRef,
}: {
  open: boolean;
  projectId: string;
  anchor: FigmaImportAnchor;
  onClose: () => void;
  onImported: (result: FigmaCanvasImportResponse) => void | Promise<void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const api = useApi();
  const [url, setUrl] = useState("");
  const [urlTouched, setUrlTouched] = useState(false);
  const [rightsAcknowledged, setRightsAcknowledged] = useState(false);
  const [credential, setCredential] = useState<FigmaCredentialStatus | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [credentialPending, setCredentialPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const submissionRef = useRef<AbortController | null>(null);
  const credentialActionRef = useRef<AbortController | null>(null);
  const credentialCheckRef = useRef<AbortController | null>(null);
  const importKeyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const preview = useMemo(() => previewFigmaImportUrl(url), [url]);
  const versionSpecific = useMemo(() => hasFigmaVersionSelection(url), [url]);

  const checkCredential = useCallback(async (): Promise<void> => {
    credentialCheckRef.current?.abort();
    const controller = new AbortController();
    credentialCheckRef.current = controller;
    setCredential(null);
    setCredentialError(null);
    try {
      const status = await api.getFigmaCredential(controller.signal);
      if (!controller.signal.aborted) setCredential(status);
    } catch (problem) {
      if (!controller.signal.aborted && !wasAborted(problem)) {
        setCredentialError("Couldn't check Figma access. Make sure the local Dezin daemon is available.");
      }
    } finally {
      if (credentialCheckRef.current === controller) credentialCheckRef.current = null;
    }
  }, [api]);

  useEffect(() => {
    if (!open) return;
    void checkCredential();
    return () => {
      credentialCheckRef.current?.abort();
      credentialCheckRef.current = null;
    };
  }, [checkCredential, open]);

  useEffect(() => () => {
    submissionRef.current?.abort();
    credentialActionRef.current?.abort();
    credentialCheckRef.current?.abort();
  }, []);

  const closeDialog = (): void => {
    submissionRef.current?.abort();
    submissionRef.current = null;
    credentialActionRef.current?.abort();
    credentialActionRef.current = null;
    credentialCheckRef.current?.abort();
    credentialCheckRef.current = null;
    if (tokenInputRef.current) tokenInputRef.current.value = "";
    setHasToken(false);
    setRightsAcknowledged(false);
    setUrlTouched(false);
    setSubmitting(false);
    setCredentialPending(false);
    setSubmitError(null);
    onClose();
  };

  const forgetCredential = async (): Promise<void> => {
    if (credentialActionRef.current || submitting) return;
    const controller = new AbortController();
    credentialActionRef.current = controller;
    setCredentialPending(true);
    setCredentialError(null);
    try {
      const status = await api.forgetFigmaCredential(controller.signal);
      if (!controller.signal.aborted) setCredential(status);
    } catch (problem) {
      if (!controller.signal.aborted && !wasAborted(problem)) {
        setCredentialError(problem instanceof Error && problem.message.trim()
          ? problem.message
          : "Couldn't forget the Figma credential.");
      }
    } finally {
      if (credentialActionRef.current === controller) {
        credentialActionRef.current = null;
        setCredentialPending(false);
      }
    }
  };

  const submitImport = async (): Promise<void> => {
    if (submissionRef.current || !preview || !rightsAcknowledged || credential === null || credentialError !== null) return;
    const token = credential.configured ? "" : tokenInputRef.current?.value.trim() ?? "";
    if (!credential.configured && !token) return;
    const controller = new AbortController();
    submissionRef.current = controller;
    setSubmitting(true);
    setSubmitError(null);
    if (tokenInputRef.current) tokenInputRef.current.value = "";
    setHasToken(false);
    try {
      let credentialStatus = credential;
      if (!credentialStatus.configured) {
        credentialStatus = await api.setFigmaCredential({ token }, controller.signal);
        if (controller.signal.aborted) return;
        setCredential(credentialStatus);
      }
      const normalizedUrl = url.trim();
      const fingerprint = JSON.stringify({
        schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
        projectId,
        anchor,
        normalizedUrl: preview.normalizedUrl,
        nodeIds: preview.nodeIds,
      });
      if (importKeyRef.current?.fingerprint !== fingerprint) {
        importKeyRef.current = { fingerprint, key: await pendingFigmaImportKey(fingerprint) };
        if (controller.signal.aborted) return;
      }
      const importKey = importKeyRef.current.key;
      const result = await api.importFigmaProject(projectId, {
        schemaVersion: FIGMA_IMPORT_SCHEMA_VERSION,
        idempotencyKey: importKey,
        url: normalizedUrl,
        ...(preview.nodeIds.length ? { nodeIds: preview.nodeIds } : {}),
        anchor,
        rightsAcknowledged: true,
      }, controller.signal);
      if (controller.signal.aborted) return;
      await clearPendingFigmaImportKey(fingerprint, importKey);
      importKeyRef.current = null;
      setUrl("");
      setUrlTouched(false);
      setRightsAcknowledged(false);
      await onImported(result);
    } catch (problem) {
      if (controller.signal.aborted || wasAborted(problem)) return;
      if (problem instanceof ApiError && problem.status === 503) setCredential({ configured: false, source: null });
      setSubmitError(figmaImportError(problem));
    } finally {
      if (submissionRef.current === controller) {
        submissionRef.current = null;
        setSubmitting(false);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      label="Import from Figma"
      className="w-[calc(100%-2rem)] max-w-lg max-h-[calc(100dvh-2rem)]"
      returnFocusRef={returnFocusRef}
    >
      <form
        className="flex max-h-[calc(100dvh-2rem)] min-h-0 flex-col overflow-hidden"
        onSubmit={(event) => {
          event.preventDefault();
          void submitImport();
        }}
      >
        <div className="shrink-0 px-5 pt-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface-2 text-foreground">
              <Figma size={18} strokeWidth={1.7} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight">Import from Figma</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Import Figma structure, visual references, tokens, and components as local canvas artifacts.
                Unavailable previews or metadata are reported as limitations.
              </p>
            </div>
          </div>
        </div>

        <div
          role="region"
          aria-label="Figma import details"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5"
        >
          <label className="block text-sm font-medium text-foreground" htmlFor="figma-import-url">
            Figma file URL
          </label>
          <Input
            id="figma-import-url"
            name="figma-url"
            type="url"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="https://www.figma.com/design/…"
            className="mt-2"
            value={url}
            aria-invalid={urlTouched && url.trim().length > 0 && preview === null ? true : undefined}
            aria-describedby={urlTouched && url.trim().length > 0 && preview === null ? "figma-import-url-error" : undefined}
            onChange={(event) => {
              setUrl(event.target.value);
              setSubmitError(null);
            }}
            onBlur={() => setUrlTouched(true)}
          />
          {urlTouched && url.trim().length > 0 && preview === null ? (
            <p id="figma-import-url-error" className="mt-2 text-xs leading-relaxed text-destructive">
              {versionSpecific
                ? "Version-specific Figma links aren't supported. Remove version-id to import the current file."
                : "Use a credential-free https://www.figma.com design, file, board, or slides link."}
            </p>
          ) : null}
          {preview ? (
            <div className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-border/80 bg-surface-2/60 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">{preview.fileName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {preview.nodeIds.length === 0 ? "Entire file" : `${preview.nodeIds.length} selected ${preview.nodeIds.length === 1 ? "Node" : "Nodes"}`}
                </p>
              </div>
              {preview.nodeIds.length > 0 ? (
                <div className="flex max-w-[55%] flex-wrap justify-end gap-1">
                  {preview.nodeIds.map((nodeId) => (
                    <span key={nodeId} className="rounded-md bg-background px-1.5 py-1 font-mono text-[11px] text-muted-foreground shadow-sm">
                      Node {nodeId}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Your Figma credential stays in the local Dezin daemon.
          </p>

          {credential === null && credentialError === null ? (
            <p className="mt-4 text-xs text-muted-foreground" role="status">Checking Figma access…</p>
          ) : null}
          {credentialError ? (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
              <span>{credentialError}</span>
              <Button type="button" variant="outline" size="xs" onClick={() => void checkCredential()}>
                Retry Figma access
              </Button>
            </div>
          ) : null}
          {credential && !credential.configured ? (
            <div className="mt-4 rounded-xl border border-border/80 bg-surface-2/40 p-3">
              <label className="block text-sm font-medium text-foreground" htmlFor="figma-import-token">
                Figma personal access token
              </label>
              <Input
                ref={tokenInputRef}
                id="figma-import-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="figd_…"
                className="mt-2 bg-background"
                onChange={(event) => setHasToken(event.target.value.trim().length > 0)}
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Stored only in the local Dezin daemon. Never written to the Project or Canvas.
              </p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                Required scopes: file_content:read + file_metadata:read. file_variables:read is optional for exact Variables.{" "}
                <a
                  href="https://developers.figma.com/docs/rest-api/scopes/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Figma token scope guide"
                  className="text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-foreground"
                >
                  Scope guide
                </a>
              </p>
            </div>
          ) : null}
          {credential?.configured ? (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-border/80 bg-surface-2/40 px-3 py-2.5">
              <KeyRound size={15} strokeWidth={1.75} className="shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">
                  {credential.source === "environment" ? "Using FIGMA_ACCESS_TOKEN" : "Personal access token stored locally"}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">The token value is never returned to this window.</p>
              </div>
              {credential.source === "local" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={credentialPending || submitting}
                  onClick={() => void forgetCredential()}
                >
                  {credentialPending ? "Forgetting…" : "Forget credential"}
                </Button>
              ) : null}
            </div>
          ) : null}

          {submitError ? (
            <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive" role="alert">
              {submitError}
            </p>
          ) : null}

          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/80 px-3 py-3 text-sm leading-relaxed text-foreground">
            <input
              type="checkbox"
              aria-label="I have permission to import and use this Figma file"
              checked={rightsAcknowledged}
              onChange={(event) => setRightsAcknowledged(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            />
            <span>
              I have permission to import and use this Figma file
              <span className="mt-0.5 block text-xs text-muted-foreground">Only import work you own or are authorized to use.</span>
            </span>
          </label>
        </div>

        <div className="flex shrink-0 justify-end gap-2 px-5 pb-5 pt-6">
          <Button type="button" variant="ghost" onClick={closeDialog}>{submitting ? "Cancel import" : "Cancel"}</Button>
          <Button
            type="submit"
            aria-busy={submitting || undefined}
            disabled={submitting || !preview || !rightsAcknowledged || credential === null || credentialError !== null || (!credential.configured && !hasToken)}
          >
            {submitting ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            {submitting ? "Importing…" : "Import into canvas"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
