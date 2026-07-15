import { AlignCenter, AlignLeft, AlignRight, Braces, Layers3, Link2, LockKeyhole, Type } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArtifactEditorController } from "./ArtifactEditorSurface.tsx";

export function ArtifactInspector({ editor }: { editor: ArtifactEditorController }) {
  const [textDraft, setTextDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("text.primary");
  const selection = editor.selection;

  useEffect(() => {
    setTextDraft(selection?.text ?? "");
    setLabelDraft("");
  }, [selection?.id, selection?.text]);

  const mutationDisabled = editor.mutationDisabled;
  const textMutationDisabled = mutationDisabled || !selection?.textMutationCapable;
  return (
    <section className="artifact-inspector" aria-labelledby="artifact-inspector-title">
      <header className="artifact-inspector__header app-drag">
        <div>
          <h2 id="artifact-inspector-title">Inspector</h2>
          <p>{editor.artifact?.kind === "component" ? "Component properties" : "Page properties"}</p>
        </div>
        {selection ? (
          <button type="button" className="app-no-drag" onClick={editor.clearSelection}>Clear</button>
        ) : null}
      </header>

      {editor.preview.readOnly ? (
        <div role="status" aria-label="Historical preview is read-only" className="artifact-inspector__readonly">
          <LockKeyhole aria-hidden size={14} />
          <span>Historical revision. Restore or fork it before editing.</span>
        </div>
      ) : null}

      <section className="artifact-inspector__section" aria-labelledby="artifact-outline-title">
        <h3 id="artifact-outline-title"><Layers3 aria-hidden size={13} /> Outline</h3>
        <div className="artifact-outline-row">
          <span>{editor.artifact?.kind === "component" ? "Master" : "Frame"}</span>
          <strong>{editor.artifact?.name ?? "Unavailable"}</strong>
        </div>
        <div className="artifact-outline-row">
          <span>Source root</span>
          <code>{editor.artifact?.sourceRoot ?? "—"}</code>
        </div>
      </section>

      <section className="artifact-inspector__section" aria-labelledby="artifact-selection-title">
        <h3 id="artifact-selection-title"><Braces aria-hidden size={13} /> Selection</h3>
        {selection === null ? (
          <div className="artifact-inspector__empty">
            <p>Choose an element in the live preview. Its stable locator becomes typed Agent Context and unlocks bounded direct edits.</p>
            <button
              type="button"
              disabled={editor.preview.status !== "ready"}
              onClick={editor.beginSelection}
              aria-pressed={editor.pickerActive}
              aria-label="Select an element in the preview"
            >
              {editor.pickerActive ? "Picker active" : "Select in preview"}
            </button>
          </div>
        ) : (
          <div className="artifact-selection-card">
            <div className="artifact-selection-card__title">
              <span>{selection.tag ?? "element"}</span>
              <strong>{selection.locator.designNodeId}</strong>
            </div>
            {selection.locator.sourcePath ? <code>{selection.locator.sourcePath}</code> : null}
            {selection.locator.selector ? <p>{selection.locator.selector}</p> : null}
            {selection.mutationUnavailableReason ? (
              <p role="status" aria-label="Direct editing unavailable" className="artifact-selection-card__notice">
                {selection.mutationUnavailableReason}
              </p>
            ) : null}
          </div>
        )}
      </section>

      {selection ? (
        <section className="artifact-inspector__section artifact-inspector__properties" aria-labelledby="artifact-properties-title">
          <h3 id="artifact-properties-title"><Type aria-hidden size={13} /> Direct properties</h3>
          <label>
            <span>Text content</span>
            <textarea
              data-artifact-mutation
              aria-label="Text content"
              value={textDraft}
              disabled={textMutationDisabled}
              rows={3}
              onChange={(event) => setTextDraft(event.target.value)}
              onBlur={() => {
                if (!textMutationDisabled && selection.text !== null && textDraft !== selection.text) {
                  void editor.applyMutation({
                    type: "set-text",
                    locator: selection.locator,
                    expectedCurrentValue: selection.text,
                    value: textDraft,
                  });
                }
              }}
            />
            {selection.textMutationUnavailableReason ? (
              <span role="status" aria-label="Text editing unavailable" className="artifact-selection-card__notice">
                {selection.textMutationUnavailableReason}
              </span>
            ) : null}
          </label>
          <label>
            <span>Accessible label</span>
            <input
              data-artifact-mutation
              aria-label="Accessible label"
              value={labelDraft}
              disabled={mutationDisabled}
              onChange={(event) => setLabelDraft(event.target.value)}
              onBlur={() => {
                if (!mutationDisabled && labelDraft.trim()) {
                  void editor.applyMutation({
                    type: "set-accessible-label",
                    locator: selection.locator,
                    value: labelDraft.trim(),
                  });
                }
              }}
            />
          </label>
          <label>
            <span>Color token</span>
            <div className="artifact-property-inline">
              <input
                data-artifact-mutation
                aria-label="Color token"
                value={tokenDraft}
                disabled={mutationDisabled}
                onChange={(event) => setTokenDraft(event.target.value)}
              />
              <button
                type="button"
                data-artifact-mutation
                disabled={mutationDisabled || tokenDraft.trim().length === 0}
                onClick={() => void editor.applyMutation({
                  type: "set-token",
                  locator: selection.locator,
                  property: "color",
                  token: tokenDraft.trim(),
                })}
              >
                Apply
              </button>
            </div>
          </label>
          <fieldset disabled={mutationDisabled}>
            <legend>Alignment</legend>
            <div className="artifact-alignment" role="group" aria-label="Element alignment">
              {([
                ["start", AlignLeft, "Align start"],
                ["center", AlignCenter, "Align center"],
                ["end", AlignRight, "Align end"],
              ] as const).map(([alignment, Icon, label]) => (
                <button
                  key={alignment}
                  type="button"
                  data-artifact-mutation
                  aria-label={label}
                  disabled={mutationDisabled}
                  onClick={() => void editor.applyMutation({
                    type: "set-layout",
                    locator: selection.locator,
                    patch: { alignment },
                  })}
                >
                  <Icon aria-hidden size={14} />
                </button>
              ))}
            </div>
          </fieldset>
        </section>
      ) : null}

      <section className="artifact-inspector__section" aria-labelledby="artifact-context-title">
        <h3 id="artifact-context-title"><Link2 aria-hidden size={13} /> Context</h3>
        <dl className="artifact-context-list">
          <div><dt>Track</dt><dd>{editor.tracks.find((track) => track.id === editor.artifact?.activeTrackId)?.name ?? "Main"}</dd></div>
          <div><dt>Revision</dt><dd>{editor.revision ? `r${editor.revision.sequence}` : "Unpublished"}</dd></div>
          <div><dt>Dependencies</dt><dd>{editor.preview.resolved?.dependencyLockHash.slice(0, 8) ?? "Resolving"}</dd></div>
        </dl>
      </section>

      <div className="artifact-inspector__save" aria-live="polite">
        {editor.mutationState.status === "saving" ? "Publishing direct edit…" : null}
        {editor.mutationState.status === "saved" ? `Saved as Revision ${editor.mutationState.revisionSequence}` : null}
        {editor.mutationState.status === "error" ? <span role="alert">{editor.mutationState.message}</span> : null}
      </div>
    </section>
  );
}
