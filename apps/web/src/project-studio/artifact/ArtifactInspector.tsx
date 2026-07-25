import { AlignCenter, AlignLeft, AlignRight, Braces, Layers3, Link2, LockKeyhole, Type } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  Input,
  StudioFactRow,
  StudioHeaderActions,
  StudioHeaderCopy,
  StudioInspectorSection,
  StudioPanelHeader,
  Textarea,
} from "../../components/ui/index.ts";
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
  const pickerReady = editor.preview.status === "ready"
    && editor.frameState.status === "applied"
    && editor.frameState.frameId === editor.activeFrame.id;
  return (
    <section className="artifact-inspector" aria-labelledby="artifact-inspector-title">
      <StudioPanelHeader draggable className="artifact-inspector__header">
        <StudioHeaderCopy
          title="Inspector"
          subtitle={editor.artifact?.kind === "component" ? "Component properties" : "Page properties"}
          titleId="artifact-inspector-title"
          headingLevel={2}
        />
        {selection ? (
          <StudioHeaderActions>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={editor.clearSelection}
            >
              Clear
            </Button>
          </StudioHeaderActions>
        ) : null}
      </StudioPanelHeader>

      <div className="artifact-inspector__body">
        {editor.preview.readOnly ? (
          <div role="status" aria-label="Historical preview is read-only" className="artifact-inspector__readonly">
            <LockKeyhole aria-hidden size={14} />
            <span>This exact Revision is immutable. Restore it as a new Revision or fork a Track; saved history is never rewritten.</span>
          </div>
        ) : null}

        <StudioInspectorSection
          className="artifact-inspector__section"
          heading="Outline"
          headingId="artifact-outline-title"
          icon={<Layers3 aria-hidden size={13} />}
        >
          <dl className="divide-y divide-border">
            <StudioFactRow
              label={editor.artifact?.kind === "component" ? "Master" : "Frame"}
              value={editor.artifact?.name ?? "Unavailable"}
              valueClassName="font-medium"
            />
            <StudioFactRow
              label="Source root"
              value={editor.artifact?.sourceRoot ?? "—"}
              metadata
              mono
            />
          </dl>
        </StudioInspectorSection>

      <StudioInspectorSection
        className="artifact-inspector__section"
        heading="Selection"
        headingId="artifact-selection-title"
        icon={<Braces aria-hidden size={13} />}
      >
        {selection === null ? (
          <div className="artifact-inspector__empty">
            <p>{editor.notGenerated
              ? "Generate this Artifact before selecting and editing elements."
              : "Choose an element in the live preview. Its stable locator becomes typed Agent Context and unlocks bounded direct edits."}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!pickerReady}
              onClick={editor.beginSelection}
              aria-pressed={editor.pickerActive}
              aria-label="Select an element in the preview"
            >
              {editor.pickerActive ? "Picker active" : "Select in preview"}
            </Button>
          </div>
        ) : (
          <div className="artifact-selection-card">
            <div className="artifact-selection-card__title">
              <span>{selection.tag ?? "element"}</span>
              <strong title={selection.label}>{selection.label}</strong>
            </div>
            <code title={selection.locator.designNodeId}>{selection.locator.designNodeId}</code>
            {selection.locator.sourcePath ? <code>{selection.locator.sourcePath}</code> : null}
            {selection.locator.selector ? <p>{selection.locator.selector}</p> : null}
            {selection.mutationUnavailableReason ? (
              <p role="status" aria-label="Direct editing unavailable" className="artifact-selection-card__notice">
                {selection.mutationUnavailableReason}
              </p>
            ) : null}
          </div>
        )}
      </StudioInspectorSection>

      {selection ? (
        <StudioInspectorSection
          className="artifact-inspector__section artifact-inspector__properties"
          heading="Direct properties"
          headingId="artifact-properties-title"
          icon={<Type aria-hidden size={13} />}
        >
          <label>
            <span>Text content</span>
            <Textarea
              data-artifact-mutation
              aria-label="Text content"
              className="min-h-20"
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
            <Input
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
              <Input
                data-artifact-mutation
                aria-label="Color token"
                value={tokenDraft}
                disabled={mutationDisabled}
                onChange={(event) => setTokenDraft(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
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
              </Button>
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
                <Button
                  key={alignment}
                  type="button"
                  size="sm"
                  variant="ghost"
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
                </Button>
              ))}
            </div>
          </fieldset>
        </StudioInspectorSection>
      ) : null}

      <StudioInspectorSection
        className="artifact-inspector__section"
        heading="Context"
        headingId="artifact-context-title"
        icon={<Link2 aria-hidden size={13} />}
      >
        <dl className="divide-y divide-border">
          <StudioFactRow
            label="Track"
            value={editor.tracks.find((track) => track.id === editor.artifact?.activeTrackId)?.name ?? "Main"}
          />
          <StudioFactRow
            label="Revision"
            value={editor.revision ? `r${editor.revision.sequence}` : "Unpublished"}
            metadata={editor.revision != null}
            mono={editor.revision != null}
          />
          <StudioFactRow
            label="Dependencies"
            value={editor.notGenerated
              ? "Not available"
              : editor.preview.resolved?.dependencyLockHash.slice(0, 8) ?? "Resolving"}
            metadata={!editor.notGenerated && editor.preview.resolved != null}
            mono={!editor.notGenerated && editor.preview.resolved != null}
          />
        </dl>
      </StudioInspectorSection>

        <div className="artifact-inspector__save" aria-live="polite">
          {editor.mutationState.status === "saving" ? "Publishing direct edit…" : null}
          {editor.mutationState.status === "saved" ? `Saved as Revision ${editor.mutationState.revisionSequence}` : null}
          {editor.mutationState.status === "error" ? <span role="alert">{editor.mutationState.message}</span> : null}
        </div>
      </div>
    </section>
  );
}
