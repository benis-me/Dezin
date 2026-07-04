/**
 * Path helpers for the research/ project convention. All paths are derived from a
 * project directory so the package stays decoupled from the daemon's data layout.
 * See docs/DESIGN-PROCESS.md for the full convention.
 */

import { join } from "node:path";

export const RESEARCH_DIRNAME = ".research";
export const BRIEF_FILE = "brief.md";
export const REPORT_FILE = "research.md";
export const SOURCES_FILE = "sources.json";
export const ASSETS_DIRNAME = "assets";
export const DIRECTIONS_DIRNAME = "directions";
export const DIRECTION_FILE = "direction.md";

export function researchDir(projectDir: string): string {
  return join(projectDir, RESEARCH_DIRNAME);
}
export function briefPath(projectDir: string): string {
  return join(researchDir(projectDir), BRIEF_FILE);
}
export function reportPath(projectDir: string): string {
  return join(researchDir(projectDir), REPORT_FILE);
}
export function sourcesPath(projectDir: string): string {
  return join(researchDir(projectDir), SOURCES_FILE);
}
export function assetsDir(projectDir: string): string {
  return join(researchDir(projectDir), ASSETS_DIRNAME);
}
export function directionsDir(projectDir: string): string {
  return join(researchDir(projectDir), DIRECTIONS_DIRNAME);
}
export function directionDir(projectDir: string, slug: string): string {
  return join(directionsDir(projectDir), slug);
}
export function directionPath(projectDir: string, slug: string): string {
  return join(directionDir(projectDir, slug), DIRECTION_FILE);
}
