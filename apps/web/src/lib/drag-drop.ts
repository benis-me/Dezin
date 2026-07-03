import type { DragEvent as ReactDragEvent } from "react";

type FileWithPath = File & { path?: string };

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  isFile: true;
  file: (success: (file: File) => void, error?: (err: DOMException) => void) => void;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (success: (entries: FileSystemEntryLike[]) => void, error?: (err: DOMException) => void) => void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  isDirectory: true;
  createReader: () => FileSystemDirectoryReaderLike;
}

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

export function hasDraggedFiles(event: ReactDragEvent<Element>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files") || (event.dataTransfer?.files?.length ?? 0) > 0;
}

export function localPathsFromDataTransfer(dataTransfer: DataTransfer | null | undefined): string[] {
  const paths = new Set<string>();
  for (const file of Array.from(dataTransfer?.files ?? [])) {
    const path = (file as FileWithPath).path;
    if (path) paths.add(path);
  }
  for (const item of Array.from(dataTransfer?.items ?? [])) {
    const file = item.getAsFile?.();
    const path = file ? (file as FileWithPath).path : undefined;
    if (path) paths.add(path);
  }
  return [...paths];
}

export async function filesFromDataTransfer(dataTransfer: DataTransfer | null | undefined): Promise<File[]> {
  const items = Array.from(dataTransfer?.items ?? []) as DataTransferItemWithEntry[];
  const entries: FileSystemEntryLike[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.() as FileSystemEntryLike | null | undefined;
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    const files = (await Promise.all(entries.map(filesFromEntry))).flat();
    if (files.length) return files;
  }
  return Array.from(dataTransfer?.files ?? []);
}

async function filesFromEntry(entry: FileSystemEntryLike): Promise<File[]> {
  if (entry.isFile) {
    return [await fileFromEntry(entry as FileSystemFileEntryLike)];
  }
  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries(entry as FileSystemDirectoryEntryLike);
    return (await Promise.all(children.map(filesFromEntry))).flat();
  }
  return [];
}

function fileFromEntry(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAllDirectoryEntries(entry: FileSystemDirectoryEntryLike): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}
