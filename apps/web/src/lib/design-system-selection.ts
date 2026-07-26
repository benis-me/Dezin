/** Must stay aligned with packages/core/src/types.ts. */
export const NO_DESIGN_SYSTEM_ID = "__dezin_no_design_system__";

export function designSystemPickerValue(id: string | null): string {
  return id === NO_DESIGN_SYSTEM_ID ? "" : (id ?? "");
}

export function persistedDesignSystemId(pickerValue: string): string {
  return pickerValue || NO_DESIGN_SYSTEM_ID;
}
