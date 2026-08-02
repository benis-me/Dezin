/** Browser-held image bytes passed from Home into a newly created Design canvas. */
export interface DesignProjectImageAttachment {
  name: string;
  /** Base64 bytes without a data URL prefix. */
  base64: string;
  mimeType?: "image/png" | "image/jpeg";
}

/** Exact immutable source identity for a cross-project canvas context attachment. */
export interface DesignProjectReferenceIdentity {
  sourceProjectId: string;
  sourceNodeId: string;
  sourceVersionId: string;
}

export interface DesignProjectReferenceAttachment {
  name: string;
  /** Base64 bytes without a data URL prefix. */
  base64: string;
  projectReference?: DesignProjectReferenceIdentity;
}

export interface DesignProjectAttachments {
  images: DesignProjectImageAttachment[];
  refs: DesignProjectReferenceAttachment[];
}
