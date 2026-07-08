import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { ChevronLeft, FileUp, FolderPlus, ImagePlus, Sparkles, X } from "lucide-react";
import { Button } from "../components/ui/index.ts";
import { AgentModelSelect } from "../components/AgentModelSelect.tsx";
import { useApi } from "../lib/api-context.tsx";
import { useAgents } from "../lib/agents-context.tsx";
import { useToast } from "../components/Toast.tsx";
import { navigate } from "../router.tsx";
import { native } from "../lib/native.ts";
import { filesFromDataTransfer, hasDraggedFiles, localPathsFromDataTransfer } from "../lib/drag-drop.ts";

/** A labelled resource row — a description on the left, a drop/browse target on the right. */
function ResourceRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-t border-border py-4 first:border-0 first:pt-0 sm:grid-cols-[210px_1fr] sm:items-start sm:gap-4">
      <div className="pt-1.5">
        <p className="text-sm font-semibold">{label}</p>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function DropButton({
  icon,
  children,
  onClick,
  onDropFiles,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  onDropFiles?: (event: ReactDragEvent<HTMLButtonElement>) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onDragEnter={(event) => {
        if (!onDropFiles || !hasDraggedFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!onDropFiles || !hasDraggedFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (!onDropFiles || !hasDraggedFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        onDropFiles(event);
      }}
      className={`flex w-full items-center justify-center gap-2 rounded-lg border border-dashed bg-surface-2/40 py-3 text-sm transition-colors hover:border-border-strong hover:text-foreground ${
        dragging ? "border-ring text-foreground ring-2 ring-ring/30" : "border-border text-muted-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

export function DesignSystemNewScreen() {
  const api = useApi();
  const { toast } = useToast();
  const { agents, rescan: rescanAgents } = useAgents();
  const [blurb, setBlurb] = useState("");
  const [notes, setNotes] = useState("");
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [fig, setFig] = useState<{ name: string; summary: string } | null>(null);
  const [assets, setAssets] = useState<string[]>([]);
  const [settingsAgent, setSettingsAgent] = useState<string | null>(null);
  const [settingsModel, setSettingsModel] = useState("");
  const [designAgent, setDesignAgent] = useState("");
  const [designModel, setDesignModel] = useState("");
  const [busy, setBusy] = useState(false);
  const figInputRef = useRef<HTMLInputElement>(null);
  const assetInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        setSettingsAgent(settings.agentCommand ?? "");
        setSettingsModel(settings.model ?? "");
      })
      .catch(() => alive && setSettingsAgent(""));
    return () => {
      alive = false;
    };
  }, [api]);

  useEffect(() => {
    if (settingsAgent === null) return;
    const available = agents.filter((agent) => agent.available);
    if (!available.length) return;
    const useSaved = settingsAgent !== "" && available.some((agent) => agent.command === settingsAgent);
    setDesignAgent((current) => current || (useSaved ? settingsAgent : available[0]!.command));
    if (useSaved && settingsModel) setDesignModel((current) => current || settingsModel);
  }, [agents, settingsAgent, settingsModel]);

  const changeDesignAgent = useCallback((command: string) => {
    setDesignAgent(command);
    setDesignModel("");
  }, []);

  const changeDesignModel = useCallback((model: string) => {
    setDesignModel(model);
  }, []);

  const pickFolder = async (): Promise<void> => {
    if (!native) return toast("Folder linking needs the desktop app.");
    const paths = await native.pickFolder();
    if (paths.length) setLocalPath(paths[0]!);
  };

  const readFig = async (file: File): Promise<void> => {
    if (!file) return;
    toast(`Reading ${file.name}…`);
    try {
      const r = await api.parseFig(file, file.name);
      if (r.summary.trim()) {
        setFig({ name: file.name, summary: r.summary });
        toast(`Parsed ${file.name}.`);
      } else toast("Couldn't extract a design from that .fig.", { variant: "error" });
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message : `Couldn't read ${file.name}.`;
      toast(message, { variant: "error" });
    }
  };

  const onFig = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await readFig(file);
  };

  const addAssets = (files: File[]): void => {
    const names = files.map((file) => file.name).filter(Boolean);
    if (!names.length) return;
    setAssets((current) => [...current, ...names]);
    // Asset file UPLOAD isn't wired up yet (importBrand takes no asset content). Record the names so
    // the choice isn't silently lost, but tell the user the files themselves aren't sent — don't
    // pretend they were attached.
    toast("Fonts/logos aren't uploaded yet — noted as reference. Describe them in the brief for now.");
  };

  const onFolderDrop = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const paths = localPathsFromDataTransfer(event.dataTransfer);
    if (paths.length) {
      setLocalPath(paths[0]!);
      return;
    }
    toast("Drop a folder from the desktop app, or pick one.", { variant: "error" });
  };

  const onFigDrop = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const dataTransfer = event.dataTransfer;
    void filesFromDataTransfer(dataTransfer).then((files) => {
      const file = files.find((item) => item.name.toLowerCase().endsWith(".fig"));
      if (!file) {
        toast("Drop a .fig file.", { variant: "error" });
        return;
      }
      void readFig(file);
    });
  };

  const onAssetsDrop = (event: ReactDragEvent<HTMLButtonElement>): void => {
    const dataTransfer = event.dataTransfer;
    void filesFromDataTransfer(dataTransfer).then(addAssets);
  };

  const create = async (): Promise<void> => {
    const text = blurb.trim();
    if (!text) return toast("Tell us about the brand first.", { variant: "error" });
    setBusy(true);
    try {
      // Pull real hints out of an attached .fig (palette + fonts); otherwise sensible defaults.
      const accent = (fig?.summary.match(/Palette:\s*(#[0-9a-fA-F]{6})/)?.[1] ?? "#2563eb").trim();
      const display = fig?.summary.match(/Fonts:\s*([^,.]+)/)?.[1]?.trim() || undefined;
      const name = (text.split(/[\n.:]/)[0] ?? text).trim().slice(0, 48) || "Design system";
      const vibe = [text, notes.trim(), fig ? `Reference (${fig.name}): ${fig.summary}` : "", localPath ? `Local code: ${localPath}` : ""]
        .filter(Boolean)
        .join("\n\n");
      const card = await api.importBrand({
        name,
        accent,
        displayFont: display,
        vibe,
        agentCommand: designAgent || undefined,
        model: designModel || undefined,
      });
      toast(`Created ${card.name}.`);
      navigate(`/design-systems/${card.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the system.", { variant: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <input ref={figInputRef} type="file" accept=".fig" className="hidden" onChange={(e) => void onFig(e)} />
      <input
        ref={assetInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          addAssets(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <div className="app-drag flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <button
          type="button"
          aria-label="Back to design systems"
          onClick={() => navigate("/design-systems")}
          className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground"
        >
          <ChevronLeft size={16} strokeWidth={2} />
        </button>
        <h1 className="text-sm font-semibold tracking-tight">New design system</h1>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-6 py-10">
          <h2 className="text-center text-2xl font-semibold tracking-tight">Set up your design system</h2>
          <p className="mt-1.5 text-center text-sm text-muted-foreground">Tell us about your brand and attach any design resources you have.</p>

          <div className="mt-8">
            <label htmlFor="blurb" className="text-sm font-medium">
              Company name and blurb <span className="font-normal text-muted-foreground">(or name of design system)</span>
            </label>
            <textarea
              id="blurb"
              value={blurb}
              onChange={(e) => setBlurb(e.target.value)}
              rows={3}
              placeholder="e.g. Mission Impastabowl: fast-casual pasta restaurant with in-store touchscreen kiosk, mobile app and website"
              className="mt-2 w-full resize-none rounded-lg border border-input bg-card/60 px-3.5 py-3 text-sm leading-relaxed outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">Builder</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Local to this design system.</p>
            </div>
            <AgentModelSelect
              agents={agents}
              agent={designAgent}
              model={designModel}
              onAgentChange={changeDesignAgent}
              onModelChange={changeDesignModel}
              onRescan={rescanAgents}
            />
          </div>

          <div className="mt-9">
            <h3 className="text-lg font-semibold tracking-tight">
              Provide examples of your design system and products <span className="text-base font-normal text-muted-foreground">(all optional)</span>
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">What works best: code and designs for your design system and your code products.</p>

            <div className="mt-4 rounded-xl border border-border p-4">
              <ResourceRow label="Link code from your computer" hint="The agent copies selected files; for large codebases attach a focused subfolder.">
                {localPath ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
                    <span className="truncate font-mono text-xs">{localPath}</span>
                    <button type="button" aria-label="Remove folder" onClick={() => setLocalPath(null)} className="text-muted-foreground hover:text-foreground">
                      <X size={14} strokeWidth={2} />
                    </button>
                  </div>
                ) : (
                  <DropButton icon={<FolderPlus size={15} strokeWidth={1.75} />} onClick={() => void pickFolder()} onDropFiles={onFolderDrop}>
                    Pick a folder…
                  </DropButton>
                )}
              </ResourceRow>

              <ResourceRow label="Upload a .fig file" hint="Parsed locally — never uploaded to a third party. Its palette and fonts seed the system.">
                {fig ? (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
                    <span className="truncate">{fig.name}</span>
                    <button type="button" aria-label="Remove .fig" onClick={() => setFig(null)} className="text-muted-foreground hover:text-foreground">
                      <X size={14} strokeWidth={2} />
                    </button>
                  </div>
                ) : (
                  <DropButton icon={<FileUp size={15} strokeWidth={1.75} />} onClick={() => figInputRef.current?.click()} onDropFiles={onFigDrop}>
                    Choose a .fig file…
                  </DropButton>
                )}
              </ResourceRow>

              <ResourceRow label="Add fonts, logos and assets">
                <DropButton icon={<ImagePlus size={15} strokeWidth={1.75} />} onClick={() => assetInputRef.current?.click()} onDropFiles={onAssetsDrop}>
                  Choose files…
                </DropButton>
                {assets.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {assets.map((a, i) => (
                      <span key={`${a}-${i}`} className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs">
                        {a}
                        <button type="button" aria-label={`Remove ${a}`} onClick={() => setAssets((cur) => cur.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
                          <X size={11} strokeWidth={2} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </ResourceRow>
            </div>
          </div>

          <div className="mt-8">
            <label htmlFor="notes" className="text-sm font-medium">
              Any other notes?
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. We use a warm, earthy colour palette with rounded corners. Our brand voice is playful but professional…"
              className="mt-2 w-full resize-none rounded-lg border border-input bg-card/60 px-3.5 py-3 text-sm leading-relaxed outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>

          <div className="mt-8 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate("/design-systems")}>
              Cancel
            </Button>
            <Button disabled={busy || !blurb.trim()} onClick={() => void create()}>
              <Sparkles size={15} strokeWidth={2} />
              {busy ? "Creating…" : "Create design system"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
