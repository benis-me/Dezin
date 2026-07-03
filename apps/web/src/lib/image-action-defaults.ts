export const IMAGE_ACTION_MODEL_FIELDS = ["removeBackgroundModel", "editRegionModel", "extractLayerModel"] as const;

export type ImageActionModelField = (typeof IMAGE_ACTION_MODEL_FIELDS)[number];

export interface ImageActionDefault {
  field: ImageActionModelField;
  label: string;
  action: string;
  desc: string;
}

export const IMAGE_ACTION_DEFAULTS: ImageActionDefault[] = [
  {
    field: "removeBackgroundModel",
    label: "Remove background model",
    action: "Remove background",
    desc: "Used by single and batch background removal actions.",
  },
  {
    field: "editRegionModel",
    label: "Edit region model",
    action: "Edit region",
    desc: "Used when editing a selected image region.",
  },
  {
    field: "extractLayerModel",
    label: "Extract layer model",
    action: "Extract layer",
    desc: "Used when cutting a subject or layer out of an image.",
  },
];

const NORMALIZED_ACTION_FIELDS: Record<string, ImageActionModelField> = {
  "remove background": "removeBackgroundModel",
  "remove backgrounds": "removeBackgroundModel",
  "edit region": "editRegionModel",
  "edit regions": "editRegionModel",
  "extract layer": "extractLayerModel",
  "extract layers": "extractLayerModel",
};

export function imageActionModelField(action: string): ImageActionModelField | null {
  return NORMALIZED_ACTION_FIELDS[action.trim().toLowerCase()] ?? null;
}

export function imageActionDefaultForField(field: ImageActionModelField): ImageActionDefault {
  return IMAGE_ACTION_DEFAULTS.find((item) => item.field === field) ?? IMAGE_ACTION_DEFAULTS[0]!;
}

export function imageActionSettingsTarget(field: ImageActionModelField): string {
  return `defaults:${field}`;
}
