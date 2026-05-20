import { useCallback, useRef } from "react";
import type { TimelineElement } from "../player";
import { usePlayerStore } from "../player";
import { applyPatchByTarget, readAttributeByTarget } from "../utils/sourcePatcher";
import { formatTimelineAttributeNumber } from "../player/components/timelineEditing";
import {
  buildTimelineAssetId,
  buildTimelineAssetInsertHtml,
  buildTimelineFileDropPlacements,
  getTimelineAssetKind,
  insertTimelineAssetIntoSource,
  resolveTimelineAssetInitialGeometry,
  resolveTimelineAssetSrc,
} from "../utils/timelineAssetDrop";
import { saveProjectFilesWithHistory } from "../utils/studioFileHistory";
import {
  getTimelineElementLabel,
  collectHtmlIds,
  resolveDroppedAssetDuration,
} from "../utils/studioHelpers";
import type { EditHistoryKind } from "../utils/editHistory";

// ── Types ──

interface RecordEditInput {
  label: string;
  kind: EditHistoryKind;
  coalesceKey?: string;
  files: Record<string, { before: string; after: string }>;
}

interface UseTimelineEditingOptions {
  projectId: string | null;
  activeCompPath: string | null;
  timelineElements: TimelineElement[];
  showToast: (message: string, tone?: "error" | "info") => void;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  reloadPreview: () => void;
  previewIframeRef: React.RefObject<HTMLIFrameElement | null>;
  pendingTimelineEditPathRef: React.MutableRefObject<string | null>;
  uploadProjectFiles: (files: Iterable<File>, dir?: string) => Promise<string[]>;
}

// ── Helpers ──

function buildPatchTarget(element: { domId?: string; selector?: string; selectorIndex?: number }) {
  if (element.domId) {
    return { id: element.domId, selector: element.selector, selectorIndex: element.selectorIndex };
  }
  if (element.selector) {
    return { selector: element.selector, selectorIndex: element.selectorIndex };
  }
  return null;
}

function findIframeElement(
  iframe: HTMLIFrameElement | null,
  element: { domId?: string; selector?: string; selectorIndex?: number },
): Element | null {
  const doc = iframe?.contentDocument;
  if (!doc) return null;
  if (element.domId) return doc.getElementById(element.domId);
  if (!element.selector) return null;
  return doc.querySelectorAll(element.selector)[element.selectorIndex ?? 0] ?? null;
}

const TIMING_ATTR_MAP: Record<string, string> = {
  start: "data-start",
  duration: "data-duration",
  track: "data-track-index",
};

function patchIframeDomTiming(
  iframe: HTMLIFrameElement | null,
  element: TimelineElement,
  updates: { start?: number; duration?: number; track?: number; playbackStart?: number },
): void {
  try {
    const el = findIframeElement(iframe, element);
    if (!el) return;
    for (const [key, attr] of Object.entries(TIMING_ATTR_MAP)) {
      const val = updates[key as keyof typeof updates];
      if (val != null) el.setAttribute(attr, formatTimelineAttributeNumber(val));
    }
    if (updates.playbackStart != null) {
      const attr =
        element.playbackStartAttr === "playback-start" ? "data-playback-start" : "data-media-start";
      el.setAttribute(attr, formatTimelineAttributeNumber(updates.playbackStart));
    }
  } catch {
    // Cross-origin or mid-navigation — safe to ignore, file is already saved.
  }
}

type PatchTarget = NonNullable<ReturnType<typeof buildPatchTarget>>;

interface PersistTimelineEditInput {
  projectId: string;
  element: TimelineElement;
  activeCompPath: string | null;
  label: string;
  buildPatches: (original: string, target: PatchTarget) => string;
  writeProjectFile: (path: string, content: string) => Promise<void>;
  recordEdit: (input: RecordEditInput) => Promise<void>;
  domEditSaveTimestampRef: React.MutableRefObject<number>;
  pendingTimelineEditPathRef: React.MutableRefObject<string | null>;
}

async function persistTimelineEdit(input: PersistTimelineEditInput): Promise<void> {
  const targetPath = input.element.sourceFile || input.activeCompPath || "index.html";
  const originalContent = await readFileContent(input.projectId, targetPath);

  const patchTarget = buildPatchTarget(input.element);
  if (!patchTarget) {
    throw new Error(`Timeline element ${input.element.id} is missing a patchable target`);
  }

  const patchedContent = input.buildPatches(originalContent, patchTarget);
  if (patchedContent === originalContent) {
    throw new Error(`Unable to patch timeline element ${input.element.id} in ${targetPath}`);
  }

  input.pendingTimelineEditPathRef.current = targetPath;
  input.domEditSaveTimestampRef.current = Date.now();
  await saveProjectFilesWithHistory({
    projectId: input.projectId,
    label: input.label,
    kind: "timeline",
    files: { [targetPath]: patchedContent },
    readFile: async () => originalContent,
    writeFile: input.writeProjectFile,
    recordEdit: input.recordEdit,
  });
  input.domEditSaveTimestampRef.current = Date.now();
}

async function readFileContent(projectId: string, targetPath: string): Promise<string> {
  const response = await fetch(
    `/api/projects/${projectId}/files/${encodeURIComponent(targetPath)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to read ${targetPath}`);
  }
  const data = (await response.json()) as { content?: string };
  if (typeof data.content !== "string") {
    throw new Error(`Missing file contents for ${targetPath}`);
  }
  return data.content;
}

// ── Hook ──

export function useTimelineEditing({
  projectId,
  activeCompPath,
  timelineElements,
  showToast,
  writeProjectFile,
  recordEdit,
  domEditSaveTimestampRef,
  reloadPreview,
  previewIframeRef,
  pendingTimelineEditPathRef,
  uploadProjectFiles,
}: UseTimelineEditingOptions) {
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const editQueueRef = useRef(Promise.resolve());
  const lastBlockedTimelineToastAtRef = useRef(0);

  const enqueueEdit = useCallback(
    (
      element: TimelineElement,
      label: string,
      buildPatches: PersistTimelineEditInput["buildPatches"],
    ) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      editQueueRef.current = editQueueRef.current
        .then(() =>
          persistTimelineEdit({
            projectId: pid,
            element,
            activeCompPath,
            label,
            buildPatches,
            writeProjectFile,
            recordEdit,
            domEditSaveTimestampRef,
            pendingTimelineEditPathRef,
          }),
        )
        .catch((error) => {
          console.error(`[Timeline] Failed to persist: ${label}`, error);
        });
    },
    [
      activeCompPath,
      recordEdit,
      writeProjectFile,
      domEditSaveTimestampRef,
      pendingTimelineEditPathRef,
    ],
  );

  const handleTimelineElementMove = useCallback(
    (element: TimelineElement, updates: Pick<TimelineElement, "start" | "track">) => {
      patchIframeDomTiming(previewIframeRef.current, element, updates);
      enqueueEdit(element, "Move timeline clip", (original, target) => {
        let patched = applyPatchByTarget(original, target, {
          type: "attribute",
          property: "start",
          value: formatTimelineAttributeNumber(updates.start),
        });
        return applyPatchByTarget(patched, target, {
          type: "attribute",
          property: "track-index",
          value: String(updates.track),
        });
      });
    },
    [previewIframeRef, enqueueEdit],
  );

  const handleTimelineElementResize = useCallback(
    (
      element: TimelineElement,
      updates: Pick<TimelineElement, "start" | "duration" | "playbackStart">,
    ) => {
      patchIframeDomTiming(previewIframeRef.current, element, updates);
      enqueueEdit(element, "Resize timeline clip", (original, target) => {
        const playbackStartAttrName =
          element.playbackStartAttr === "playback-start" ? "playback-start" : "media-start";
        const currentPlaybackStartValue =
          readAttributeByTarget(original, target, "playback-start") ??
          readAttributeByTarget(original, target, "media-start");
        const currentPlaybackStart =
          currentPlaybackStartValue != null ? parseFloat(currentPlaybackStartValue) : undefined;
        const trimDelta = updates.start - element.start;
        const fallbackPlaybackStart =
          updates.playbackStart == null &&
          trimDelta !== 0 &&
          Number.isFinite(currentPlaybackStart) &&
          currentPlaybackStart != null
            ? Math.max(
                0,
                currentPlaybackStart + trimDelta * Math.max(element.playbackRate ?? 1, 0.1),
              )
            : undefined;
        const nextPlaybackStart = updates.playbackStart ?? fallbackPlaybackStart;

        let patched = applyPatchByTarget(original, target, {
          type: "attribute",
          property: "start",
          value: formatTimelineAttributeNumber(updates.start),
        });
        patched = applyPatchByTarget(patched, target, {
          type: "attribute",
          property: "duration",
          value: formatTimelineAttributeNumber(updates.duration),
        });
        if (nextPlaybackStart != null) {
          patched = applyPatchByTarget(patched, target, {
            type: "attribute",
            property: playbackStartAttrName,
            value: formatTimelineAttributeNumber(nextPlaybackStart),
          });
        }
        return patched;
      });
    },
    [previewIframeRef, enqueueEdit],
  );

  const handleTimelineElementDelete = useCallback(
    async (element: TimelineElement) => {
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");
      const label = getTimelineElementLabel(element);

      const targetPath = element.sourceFile || activeCompPath || "index.html";
      try {
        const originalContent = await readFileContent(pid, targetPath);

        const patchTarget = buildPatchTarget(element);
        if (!patchTarget) {
          throw new Error(`Timeline element ${element.id} is missing a patchable target`);
        }

        const removeResponse = await fetch(
          `/api/projects/${pid}/file-mutations/remove-element/${encodeURIComponent(targetPath)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: patchTarget }),
          },
        );
        if (!removeResponse.ok) {
          throw new Error(`Failed to delete ${element.id} from ${targetPath}`);
        }

        const removeData = (await removeResponse.json()) as {
          changed?: boolean;
          content?: string;
        };
        const patchedContent =
          typeof removeData.content === "string" ? removeData.content : originalContent;

        domEditSaveTimestampRef.current = Date.now();
        await saveProjectFilesWithHistory({
          projectId: pid,
          label: "Delete timeline clip",
          kind: "timeline",
          files: { [targetPath]: patchedContent },
          readFile: async () => originalContent,
          writeFile: writeProjectFile,
          recordEdit,
        });

        usePlayerStore
          .getState()
          .setElements(
            timelineElements.filter((te) => (te.key ?? te.id) !== (element.key ?? element.id)),
          );
        usePlayerStore.getState().setSelectedElementId(null);
        reloadPreview();
        showToast(`Deleted ${label}. Use Undo to restore it.`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete timeline clip";
        showToast(message);
      }
    },
    [
      activeCompPath,
      recordEdit,
      showToast,
      timelineElements,
      writeProjectFile,
      domEditSaveTimestampRef,
      reloadPreview,
    ],
  );

  const handleTimelineAssetDrop = useCallback(
    async (
      assetPath: string,
      placement: Pick<TimelineElement, "start" | "track">,
      durationOverride?: number,
    ) => {
      const pid = projectIdRef.current;
      if (!pid) throw new Error("No active project");

      const kind = getTimelineAssetKind(assetPath);
      if (!kind) {
        showToast("Only image, video, and audio assets can be dropped onto the timeline.");
        return;
      }

      const targetPath = activeCompPath || "index.html";
      try {
        const originalContent = await readFileContent(pid, targetPath);

        const normalizedStart = Number(formatTimelineAttributeNumber(placement.start));
        const duration =
          Number.isFinite(durationOverride) && durationOverride != null && durationOverride > 0
            ? durationOverride
            : await resolveDroppedAssetDuration(pid, assetPath, kind);
        const normalizedDuration = Number(formatTimelineAttributeNumber(duration));
        const newId = buildTimelineAssetId(assetPath, collectHtmlIds(originalContent));
        const resolvedAssetSrc = resolveTimelineAssetSrc(targetPath, assetPath);

        const resolvedTargetPath = targetPath || "index.html";
        const relevantElements = timelineElements.filter(
          (te) => (te.sourceFile || activeCompPath || "index.html") === resolvedTargetPath,
        );
        const newElementZIndex = Math.max(1, relevantElements.length + 1);

        const patchedContent = insertTimelineAssetIntoSource(
          originalContent,
          buildTimelineAssetInsertHtml({
            id: newId,
            assetPath: resolvedAssetSrc,
            kind,
            start: normalizedStart,
            duration: normalizedDuration,
            track: placement.track,
            zIndex: newElementZIndex,
            geometry: resolveTimelineAssetInitialGeometry(originalContent),
          }),
        );

        domEditSaveTimestampRef.current = Date.now();
        await saveProjectFilesWithHistory({
          projectId: pid,
          label: "Add timeline asset",
          kind: "timeline",
          files: { [targetPath]: patchedContent },
          readFile: async () => originalContent,
          writeFile: writeProjectFile,
          recordEdit,
        });

        reloadPreview();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to drop asset onto timeline";
        showToast(message);
      }
    },
    [
      activeCompPath,
      recordEdit,
      showToast,
      timelineElements,
      writeProjectFile,
      domEditSaveTimestampRef,
      reloadPreview,
    ],
  );

  const handleTimelineFileDrop = useCallback(
    async (files: File[], placement?: Pick<TimelineElement, "start" | "track">) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      const uploaded = await uploadProjectFiles(files);
      if (uploaded.length === 0) return;
      const durations: number[] = [];
      for (const assetPath of uploaded) {
        const kind = getTimelineAssetKind(assetPath);
        const duration = kind ? await resolveDroppedAssetDuration(pid, assetPath, kind) : 0;
        durations.push(Number(formatTimelineAttributeNumber(duration)));
      }
      const placements = buildTimelineFileDropPlacements(
        placement ?? { start: 0, track: 0 },
        durations,
        timelineElements
          .filter(
            (te) =>
              (te.sourceFile || activeCompPath || "index.html") ===
              (activeCompPath || "index.html"),
          )
          .map((te) => ({
            start: te.start,
            duration: te.duration,
            track: te.track,
          })),
      );
      for (const [index, assetPath] of uploaded.entries()) {
        await handleTimelineAssetDrop(
          assetPath,
          placements[index] ?? placements[0],
          durations[index],
        );
      }
    },
    [activeCompPath, handleTimelineAssetDrop, timelineElements, uploadProjectFiles],
  );

  const handleBlockedTimelineEdit = useCallback(
    (_element: TimelineElement) => {
      const now = Date.now();
      if (now - lastBlockedTimelineToastAtRef.current < 1500) return;
      lastBlockedTimelineToastAtRef.current = now;
      showToast("This clip can't be moved or resized from the timeline yet.", "info");
    },
    [showToast],
  );

  return {
    handleTimelineElementMove,
    handleTimelineElementResize,
    handleTimelineElementDelete,
    handleTimelineAssetDrop,
    handleTimelineFileDrop,
    handleBlockedTimelineEdit,
  };
}
