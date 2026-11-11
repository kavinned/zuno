import { useEffect, useId, useState } from "react";
import { Switch } from "@/components/motion/switch";
import { ArrowDownIcon, ArrowUpIcon, GlobalIcon, TrashIcon } from "@/ui/icons";
import { cn } from "@/lib/utils";
import type { AddonHealth, AddonSourceConfig } from "../../datasource/addon/types";
import { normalizeAddonBaseUrl, redactedAddonUrl } from "../../datasource/addon/url";
import { addonRegistry, addonService } from "../../player/playerStore";
import { useAddonSources } from "./addonSources";

/**
 * One probe sweep per app run. This card remounts whenever its tab or the settings search
 * remounts it, and re-probing every source with bypassCache only invites rate limits.
 */
let probeSweepStarted = false;

const CARD = "flex flex-col gap-5 rounded-2xl bg-card/50 p-6";
const FIELD =
  "min-w-0 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-inset focus:ring-ring/60";
const BUTTON =
  "rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const DESTRUCTIVE_BUTTON =
  "rounded-full px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

const HEALTH_LABELS: Record<AddonHealth, string> = {
  ok: "Working",
  /* Timeouts, 5xx and network failures all land here; the label names what you can act on. */
  unreachable: "Not responding",
  /* A 4xx answer. A missing stored URL is named separately, so this stays honest. */
  rejected: "Rejected",
  gated: "Needs a lossless output",
  "rate-limited": "Rate limited",
};

function healthLabel(health: AddonHealth | undefined): string {
  return health === undefined ? "Not tested" : HEALTH_LABELS[health];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to update addon sources.";
}

function SourceRow({
  source,
  index,
  count,
  busy,
  onToggle,
  onMove,
  onTest,
  onEdit,
  onRemove,
}: {
  source: AddonSourceConfig;
  index: number;
  count: number;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onMove: (delta: number) => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const labelId = useId();
  const name = source.label || "Addon source";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-background/40 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={labelId} className="truncate text-sm font-medium text-foreground">
          {name}
        </span>
        {/* Never the raw base URL: the keyring keeps it secret and the path may embed it. */}
        <span className="truncate font-mono text-xs text-muted-foreground">
          {redactedAddonUrl(source.baseUrl)}
        </span>
      </span>

      <span
        className={cn(
          "shrink-0 text-xs",
          source.lastHealth === "ok" ? "text-primary" : "text-muted-foreground",
        )}
      >
        {source.baseUrl === "" ? "No URL stored" : healthLabel(source.lastHealth)}
      </span>

      <Switch
        checked={source.enabled}
        onCheckedChange={onToggle}
        /* No stored URL means the keyring secret is gone: `updateSource` would probe and
           replace hydrate's honest "Not usable" with a vague "Unreachable". */
        disabled={busy || source.baseUrl === ""}
        aria-labelledby={labelId}
      />

      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={cn(BUTTON, "grid size-8 place-items-center px-0")}
          aria-label={`Move ${name} up`}
          disabled={busy || index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUpIcon size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={cn(BUTTON, "grid size-8 place-items-center px-0")}
          aria-label={`Move ${name} down`}
          disabled={busy || index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDownIcon size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={BUTTON}
          /* No stored URL means hydrate already shows "Not usable"; a probe would overwrite it. */
          disabled={busy || source.baseUrl === ""}
          onClick={onTest}
        >
          Test
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className={DESTRUCTIVE_BUTTON}
          disabled={busy}
          onClick={onRemove}
        >
          <TrashIcon size={14} aria-hidden="true" className="mr-1 inline-block" />
          Remove
        </button>
      </span>
    </div>
  );
}

export function AddonSourcesSettings() {
  const { sources, loaded } = useAddonSources();
  const titleId = useId();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Best effort, once per run, no polling: probe what is already enabled so health is not stale.
  useEffect(() => {
    if (probeSweepStarted) return;
    probeSweepStarted = true;
    let cancelled = false;
    void addonRegistry
      .ensureLoaded()
      .then(() => {
        if (cancelled) return;
        for (const source of addonRegistry.list()) {
          /* No stored URL means the secret is gone and hydrate already calls it "Not usable";
             probing it would only replace that with a vaguer "Unreachable". */
          if (!source.enabled || source.baseUrl === "") continue;
          void addonService.probeSource(source.id).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setLabel("");
    setUrl("");
    setInsecure(false);
    setError(null);
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    setError(null);
    // A cleartext URL still submits; the warning just has to arrive before the button.
    try {
      setInsecure(normalizeAddonBaseUrl(value).insecure);
    } catch {
      setInsecure(false);
    }
  };

  const handleSubmit = async () => {
    // Without the loaded snapshot an empty `sources` would let a duplicate URL through.
    if (!loaded) return;
    setError(null);
    const nextLabel = label.trim();
    const nextUrl = url.trim();
    if (!nextLabel) {
      setError("Enter a name for this source.");
      return;
    }
    // Edit keeps the current URL when the field is left blank, so it is only required to add.
    let normalizedUrl: string | null = null;
    if (editingId === null || nextUrl !== "") {
      try {
        normalizedUrl = normalizeAddonBaseUrl(nextUrl).baseUrl;
      } catch (caught) {
        setError(errorMessage(caught));
        return;
      }
    }

    if (
      normalizedUrl !== null
      && sources.some((entry) => entry.baseUrl === normalizedUrl && entry.id !== editingId)
    ) {
      setError("This source is already added.");
      return;
    }

    setSaving(true);
    try {
      if (editingId === null) {
        await addonService.addSource(nextLabel, nextUrl);
      } else {
        await addonService.updateSource(
          editingId,
          nextUrl === "" ? { label: nextLabel } : { label: nextLabel, baseUrl: nextUrl },
        );
      }
      resetForm();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (source: AddonSourceConfig, enabled: boolean) => {
    setError(null);
    setBusyId(source.id);
    try {
      await addonService.updateSource(source.id, { enabled });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const handleMove = async (source: AddonSourceConfig, delta: number) => {
    // A second click would read the pre-reorder snapshot and lose the first step.
    if (reordering) return;
    const ids = sources.map((entry) => entry.id);
    const index = ids.indexOf(source.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;

    const moved = [...ids];
    moved[index] = ids[target];
    moved[target] = ids[index];
    setError(null);
    setReordering(true);
    try {
      await addonService.reorder(moved);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setReordering(false);
    }
  };

  const handleTest = async (source: AddonSourceConfig) => {
    setError(null);
    setBusyId(source.id);
    try {
      await addonService.probeSource(source.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const handleEdit = (source: AddonSourceConfig) => {
    setEditingId(source.id);
    setLabel(source.label);
    // Deliberately blank rather than prefilled: the base URL must not reach the DOM.
    setUrl("");
    setInsecure(false);
    setError(null);
  };

  const handleRemove = async (source: AddonSourceConfig) => {
    if (!window.confirm(`Remove ${source.label || "this addon source"}?`)) return;
    setError(null);
    setBusyId(source.id);
    try {
      await addonService.removeSource(source.id);
      if (editingId === source.id) resetForm();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className={CARD} aria-labelledby={titleId}>
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          <GlobalIcon size={18} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            Addon sources
          </h2>
          <p className="text-sm text-muted-foreground">
            Servers that supply lossless streams in place of YouTube's audio.
          </p>
        </div>
      </div>

      {!loaded ? (
        <p className="text-sm text-muted-foreground">Loading addon sources…</p>
      ) : sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No addon sources yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sources.map((source, index) => (
            <SourceRow
              key={source.id}
              source={source}
              index={index}
              count={sources.length}
              busy={reordering || busyId === source.id}
              onToggle={(enabled) => void handleToggle(source, enabled)}
              onMove={(delta) => void handleMove(source, delta)}
              onTest={() => void handleTest(source)}
              onEdit={() => handleEdit(source)}
              onRemove={() => void handleRemove(source)}
            />
          ))}
        </div>
      )}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Name
            <input
              className={cn(FIELD, "w-40")}
              type="text"
              value={label}
              disabled={saving}
              onChange={(event) => {
                setLabel(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            URL
            <input
              className={FIELD}
              type="text"
              value={url}
              disabled={saving}
              placeholder={
                editingId === null ? "https://addon.example" : "Leave blank to keep the current URL"
              }
              onChange={(event) => handleUrlChange(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            disabled={saving || !loaded}
          >
            {saving ? "Saving…" : editingId === null ? "Add" : "Save"}
          </button>
          {editingId !== null && (
            <button
              type="button"
              className="rounded-full px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              disabled={saving}
              onClick={resetForm}
            >
              Cancel
            </button>
          )}
        </div>

        {insecure && (
          <p className="text-sm text-destructive">
            This address uses plain http, so anything between you and the addon can read the
            traffic. Use https, or trust the network you are on.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
