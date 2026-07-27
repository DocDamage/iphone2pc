import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clipboard,
  Clock3,
  Command,
  Copy,
  Download,
  FileUp,
  ExternalLink,
  File,
  FileArchive,
  FileImage,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderSync,
  Gauge,
  HardDrive,
  HeartPulse,
  History,
  Images,
  Inbox,
  Info,
  Laptop,
  Link2,
  Layers3,
  LockKeyhole,
  Menu,
  MonitorDown,
  Moon,
  MoreHorizontal,
  Music2,
  PackageOpen,
  Pause,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Tag,
  Trash2,
  TrendingUp,
  UploadCloud,
  Usb,
  Video,
  Wifi,
  Zap,
  X
} from "lucide-react";
import type {
  ActiveTransfer,
  AppSettings,
  AppSnapshot,
  AutomationRule,
  ClipboardEntry,
  DevicePermissions,
  DiagnosticReport,
  DriveEntry,
  FileRequest,
  FileRequestUpload,
  MediaPreview,
  MusicLibraryItem,
  PhoneDocumentFile,
  PhoneMusicCollection,
  PhoneMusicLibrary,
  PhoneMusicTrack,
  PrivateShareLink,
  ProducerPackage,
  SharedFile,
  SyncProfile,
  TrustedDevice,
  TransferRecord,
  TransferMetadataPatch,
  TransferStatus,
  UsbDevice,
  VaultItem,
  WatchFolder
} from "../electron/core/types";
import {
  detectMediaKind,
  isPlayableMediaKind,
  type PlayableMediaKind
} from "../electron/core/media-kind";
import {
  AudioPreviewPlayer,
  type AudioPlayerSnapshot,
  type AudioPreviewPlayerHandle,
  type AudioPreviewTrack
} from "./components/AudioPreviewPlayer";
import { resolvedLanguage, translate } from "./i18n";

type Page =
  | "music"
  | "home"
  | "transfers"
  | "gallery"
  | "share"
  | "links"
  | "requests"
  | "drive"
  | "sync"
  | "studio"
  | "clipboard"
  | "usb"
  | "vault"
  | "storage"
  | "recovery"
  | "settings";
type Toast = { id: number; message: string; tone: "success" | "error" | "info" };
type ActionStatus = Pick<Toast, "message" | "tone">;
type MediaPlayerSummary = Pick<
  AudioPlayerSnapshot,
  "currentTrackId" | "status" | "isPlaying" | "error"
>;
type HistoryFilter =
  | "all"
  | TransferStatus
  | "favorite"
  | "recent"
  | "large"
  | "music"
  | "photos";

const api = window.pocketdock;

const MUSIC_PLAYER_PREFIX = "music:";
const TRANSFER_PLAYER_PREFIX = "transfer:";

function musicPlayerId(id: string): string {
  return `${MUSIC_PLAYER_PREFIX}${id}`;
}

function transferPlayerId(id: string): string {
  return `${TRANSFER_PLAYER_PREFIX}${id}`;
}

function playerSourceId(id: string): { scope: "music" | "transfer"; id: string } | null {
  if (id.startsWith(MUSIC_PLAYER_PREFIX) && id.length > MUSIC_PLAYER_PREFIX.length) {
    return { scope: "music", id: id.slice(MUSIC_PLAYER_PREFIX.length) };
  }
  if (id.startsWith(TRANSFER_PLAYER_PREFIX) && id.length > TRANSFER_PLAYER_PREFIX.length) {
    return { scope: "transfer", id: id.slice(TRANSFER_PLAYER_PREFIX.length) };
  }
  return null;
}

function getPhoneMusicCollections(library: PhoneMusicLibrary): PhoneMusicCollection[] {
  return library.collections;
}

function getPhoneMusicCollectionTrackIds(collection: PhoneMusicCollection): string[] {
  const payload = collection as unknown as {
    trackExternalIds?: unknown;
    trackIds?: unknown;
  };
  const ids = Array.isArray(payload.trackExternalIds)
    ? payload.trackExternalIds
    : Array.isArray(payload.trackIds)
      ? payload.trackIds
      : [];
  return ids.filter((id): id is string => typeof id === "string");
}

function messageFromError(error: unknown, fallback = "That action could not be completed."): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-lockup ${compact ? "compact" : ""}`}>
      <img
        className="brand-logo"
        src={
          compact
            ? "./branding/pocketdock_badge_mark.png"
            : "./branding/pocketdock_primary_horizontal.png"
        }
        alt="PocketDock"
      />
    </div>
  );
}

function formatBytes(bytes: number, precision = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value.toFixed(power === 0 ? 0 : precision)} ${units[power]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  }).format(date);
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function fileIcon(name: string, size = 19) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "heic", "webp", "svg"].includes(extension)) {
    return <FileImage size={size} />;
  }
  if (["mp4", "mov", "m4v", "avi", "mkv"].includes(extension)) {
    return <Video size={size} />;
  }
  if (["mp3", "wav", "m4a", "aac", "flac"].includes(extension)) {
    return <Music2 size={size} />;
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) {
    return <FileArchive size={size} />;
  }
  if (["txt", "pdf", "doc", "docx", "md", "rtf"].includes(extension)) {
    return <FileText size={size} />;
  }
  return <File size={size} />;
}

function EmptyState({
  icon,
  title,
  children
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

function TransferBadge({ status }: { status: TransferStatus }) {
  const labels: Record<TransferStatus, string> = {
    active: "Transferring",
    completed: "Complete",
    failed: "Failed",
    cancelled: "Cancelled"
  };
  return <span className={`status-badge ${status}`}>{labels[status]}</span>;
}

function TransferRow({
  transfer,
  onReveal,
  onToggleFavorite,
  onEdit,
  selected,
  onSelect,
  actionsDisabled = false,
  detailed = false
}: {
  transfer: TransferRecord;
  onReveal: (id: string) => void;
  onToggleFavorite?: (transfer: TransferRecord) => void;
  onEdit?: (transfer: TransferRecord) => void;
  selected?: boolean;
  onSelect?: (transfer: TransferRecord, selected: boolean) => void;
  actionsDisabled?: boolean;
  detailed?: boolean;
}) {
  return (
    <div
      className={`transfer-row ${detailed ? "detailed" : ""} ${onSelect ? "selectable" : ""} ${selected ? "selected" : ""}`}
    >
      {onSelect && (
        <input
          className="transfer-select"
          type="checkbox"
          checked={Boolean(selected)}
          disabled={actionsDisabled}
          aria-label={`Select ${transfer.fileName}`}
          onChange={(event) => onSelect(transfer, event.target.checked)}
        />
      )}
      <div className="file-type-icon">{fileIcon(transfer.fileName)}</div>
      <div className="transfer-primary">
        <strong title={transfer.fileName}>{transfer.fileName}</strong>
        <span>
          {transfer.direction === "iphone-to-pc" ? transfer.sourceDevice : "This PC"} ·{" "}
          {formatBytes(transfer.size)}
        </span>
        {detailed && Boolean(transfer.tags?.length) && (
          <div className="transfer-tags">
            {transfer.tags?.slice(0, 3).map((tag) => <em key={tag}>#{tag}</em>)}
          </div>
        )}
      </div>
      {detailed && (
        <div className="transfer-direction">
          {transfer.direction === "iphone-to-pc" ? (
            <>
              <Smartphone size={16} /> <ArrowRight size={14} /> <Laptop size={16} />
            </>
          ) : (
            <>
              <Laptop size={16} /> <ArrowRight size={14} /> <Smartphone size={16} />
            </>
          )}
        </div>
      )}
      <div className="transfer-time">{formatDate(transfer.completedAt ?? transfer.createdAt)}</div>
      <TransferBadge status={transfer.status} />
      <div className="transfer-actions">
        {onToggleFavorite && (
          <button
            className={`icon-button small favorite-button ${transfer.favorite ? "active" : ""}`}
            aria-label={transfer.favorite ? "Remove from favorites" : "Add to favorites"}
            title={transfer.favorite ? "Remove from favorites" : "Add to favorites"}
            disabled={actionsDisabled}
            onClick={() => onToggleFavorite(transfer)}
          >
            <Star size={16} fill={transfer.favorite ? "currentColor" : "none"} />
          </button>
        )}
        {onEdit && (
          <button
            className="icon-button small"
            aria-label="Edit tags and note"
            title="Tags and note"
            disabled={actionsDisabled}
            onClick={() => onEdit(transfer)}
          >
            <Tag size={16} />
          </button>
        )}
        <button
          className="icon-button small"
          aria-label="Show file in folder"
          title="Show in folder"
          disabled={actionsDisabled || !transfer.savedPath}
          onClick={() => onReveal(transfer.id)}
        >
          <FolderOpen size={17} />
        </button>
      </div>
    </div>
  );
}

function TransferMetadataDialog({
  transfer,
  onClose,
  onSave,
  saving
}: {
  transfer: TransferRecord;
  onClose: () => void;
  onSave: (patch: TransferMetadataPatch) => Promise<void>;
  saving: boolean;
}) {
  const [tags, setTags] = useState((transfer.tags ?? []).join(", "));
  const [note, setNote] = useState(transfer.note ?? "");
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="metadata-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            tags: tags.split(","),
            note
          });
        }}
      >
        <button type="button" className="modal-close" disabled={saving} onClick={onClose} aria-label="Close">
          <X size={17} />
        </button>
        <div className="settings-icon"><Tag size={21} /></div>
        <span className="eyebrow">Transfer Library</span>
        <h2 id="metadata-title">Organize this transfer</h2>
        <p className="metadata-file-name">{transfer.fileName}</p>
        <label>
          Tags
          <input
            autoFocus
            value={tags}
            disabled={saving}
            maxLength={420}
            placeholder="client, receipts, favorites"
            onChange={(event) => setTags(event.target.value)}
          />
          <small>Separate tags with commas. Up to 12 are saved locally.</small>
        </label>
        <label>
          Private note
          <textarea
            value={note}
            disabled={saving}
            maxLength={2_000}
            rows={5}
            placeholder="Add context you’ll want later…"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />} {saving ? "Saving…" : "Save details"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={`toggle ${checked ? "on" : ""}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function Onboarding({
  onDone
}: {
  onDone: () => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const screens = [
    {
      icon: <Sparkles size={38} />,
      eyebrow: "PocketDock 4",
      title: "Your private bridge between iPhone and PC.",
      body: "Move full-quality photos, videos, contacts, documents, beats, and complete folders without putting them in someone else’s cloud."
    },
    {
      icon: <QrCode size={38} />,
      eyebrow: "Start in seconds",
      title: "Scan for a quick transfer. Install the app for everything else.",
      body: "The browser transfer works instantly. The native iPhone app adds Camera Roll and contacts backup, Files integration, remote access, folder sync, and background continuation."
    },
    {
      icon: <ShieldCheck size={38} />,
      eyebrow: "Private by design",
      title: "Paired routes are encrypted, verified, and permissioned.",
      body: "Paired LAN transfers use encrypted chunks and SHA-256 verification. Remote sessions add ephemeral keys and replay protection. Each trusted iPhone gets its own capabilities."
    },
    {
      icon: <ArchiveRestore size={38} />,
      eyebrow: "Built for real workflows",
      title: "Drive, request, deliver, automate, and recover.",
      body: "Browse an approved PC folder in Files, request uploads without accounts, build client-ready producer packages with resilient artwork matching, and roll back from verified restore points."
    }
  ];
  const screen = screens[step];

  return (
    <div className="modal-backdrop">
      <div className="onboarding-card">
        <button className="modal-close" onClick={() => void onDone()} aria-label="Skip setup">
          <X size={20} />
        </button>
        <div className="onboarding-art">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <img
            className="onboarding-brand-hero"
            src="./branding/pocketdock_unframed_symbol.png"
            alt=""
          />
          <div className="floating-shield">{screen.icon}</div>
        </div>
        <div className="onboarding-copy">
          <Logo />
          <span className="eyebrow">{screen.eyebrow}</span>
          <h1>{screen.title}</h1>
          <p>{screen.body}</p>
          <div className="onboarding-footer">
            <div className="step-dots">
              {screens.map((_, index) => (
                <span key={index} className={index === step ? "active" : ""} />
              ))}
            </div>
            <button
              className="primary-button"
              onClick={() => {
                if (step < screens.length - 1) setStep(step + 1);
                else void onDone();
              }}
            >
              {step === screens.length - 1 ? "Open PocketDock" : "Continue"}
              <ArrowRight size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CommandPalette({
  onClose,
  onNavigate,
  onShare,
  onOpenFolder
}: {
  onClose: () => void;
  onNavigate: (page: Page) => void;
  onShare: () => void;
  onOpenFolder: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const commands: Array<{
    label: string;
    detail: string;
    icon: React.ReactNode;
    run: () => void;
  }> = [
    { label: "Music Library", detail: "Browse Windows audio and cached iPhone inventory", icon: <Music2 size={18} />, run: () => onNavigate("music") },
    { label: "Home", detail: "Connection and current activity", icon: <Gauge size={18} />, run: () => onNavigate("home") },
    { label: "Transfer Library", detail: "Search, tag, and review transfers", icon: <History size={18} />, run: () => onNavigate("transfers") },
    { label: "Send files to iPhone", detail: "Choose files from this PC", icon: <UploadCloud size={18} />, run: onShare },
    { label: "Private links", detail: "Create controlled encrypted delivery links", icon: <Link2 size={18} />, run: () => onNavigate("links") },
    { label: "Sync & backup", detail: "Manage automatic and remote workflows", icon: <FolderSync size={18} />, run: () => onNavigate("sync") },
    { label: "Producer Studio", detail: "Package stems and music projects", icon: <Music2 size={18} />, run: () => onNavigate("studio") },
    { label: "Encrypted Vault", detail: "Open files protected at rest", icon: <LockKeyhole size={18} />, run: () => onNavigate("vault") },
    { label: "Open save folder", detail: "Show PocketDock files in Explorer", icon: <FolderOpen size={18} />, run: onOpenFolder },
    { label: "Settings", detail: "Security, devices, and app preferences", icon: <Settings size={18} />, run: () => onNavigate("settings") }
  ];
  const normalized = query.trim().toLocaleLowerCase();
  const visible = commands.filter(
    (command) =>
      !normalized ||
      command.label.toLocaleLowerCase().includes(normalized) ||
      command.detail.toLocaleLowerCase().includes(normalized)
  );
  useEffect(() => setActiveIndex(0), [query]);
  const invoke = (command: (typeof commands)[number]) => {
    command.run();
    onClose();
  };
  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="PocketDock command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-search">
          <Search size={20} />
          <input
            autoFocus
            value={query}
            placeholder="Where do you want to go?"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (visible.length) {
                  setActiveIndex((index) => Math.min(visible.length - 1, index + 1));
                }
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              }
              if (event.key === "Enter" && visible[activeIndex]) {
                invoke(visible[activeIndex]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="command-results">
          {visible.map((command, index) => (
            <button
              key={command.label}
              className={index === activeIndex ? "active" : ""}
              aria-current={index === activeIndex ? "true" : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => invoke(command)}
            >
              <span>{command.icon}</span>
              <div><strong>{command.label}</strong><small>{command.detail}</small></div>
              {index === activeIndex && <kbd>Enter</kbd>}
            </button>
          ))}
          {!visible.length && (
            <EmptyState icon={<Search size={22} />} title="No matching action">
              Try “files”, “sync”, “vault”, or “settings”.
            </EmptyState>
          )}
        </div>
        <div className="command-footer">
          <span><Command size={13} /> PocketDock Quick Switcher</span>
          <span>Everything stays on this PC</span>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [page, setPage] = useState<Page>("music");
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<HistoryFilter>("all");
  const [commandOpen, setCommandOpen] = useState(false);
  const refreshRequestRef = useRef(0);
  const mediaPlayerRef = useRef<AudioPreviewPlayerHandle>(null);
  const [mediaPlayerSummary, setMediaPlayerSummary] = useState<MediaPlayerSummary>({
    currentTrackId: null,
    status: "idle",
    isPlaying: false,
    error: null
  });
  const [mediaPlayerPosters, setMediaPlayerPosters] = useState<Record<string, string>>({});

  const notify = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((toast) => toast.id !== id));
    }, 3_400);
  }, []);

  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      if (event.reason instanceof DOMException && event.reason.name === "AbortError") return;
      notify(messageFromError(event.reason), "error");
    };
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  }, [notify]);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    try {
      const next = await api.getSnapshot();
      if (requestId !== refreshRequestRef.current) return;
      setSnapshot(next);
      document.documentElement.dataset.theme = next.settings.theme;
      document.documentElement.dataset.density = next.settings.interfaceDensity;
      document.documentElement.dataset.contrast = next.settings.highContrast ? "high" : "normal";
      document.documentElement.style.setProperty(
        "--interface-scale",
        String(next.settings.interfaceScale)
      );
      document.documentElement.lang = resolvedLanguage(next.settings.language);
      if (next.connection.url) {
        const nextQrCode = await api.getQrCode();
        if (requestId === refreshRequestRef.current) setQrCode(nextQrCode);
      } else {
        setQrCode(null);
      }
    } catch (error) {
      if (requestId === refreshRequestRef.current) {
        setQrCode(null);
        notify(error instanceof Error ? error.message : "PocketDock could not refresh.", "error");
      }
    }
  }, [notify]);

  useEffect(() => {
    void refresh();
    void api.getOnboardingComplete().then((complete) => setOnboarding(!complete));
    return api.onTransferEvent((event) => {
      if (event.type === "upload-progress" || event.type === "upload-started") {
        const active = event.payload as ActiveTransfer | undefined;
        if (active?.id) {
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  activeTransfers: [
                    ...current.activeTransfers.filter((item) => item.id !== active.id),
                    active
                  ]
                }
              : current
          );
        }
        return;
      }
      void refresh();
      if (event.type === "upload-completed") {
        const payload = event.payload as { fileName?: string; direction?: string };
        notify(
          payload.direction === "pc-to-iphone"
            ? `${payload.fileName ?? "File"} was downloaded to your iPhone.`
            : `${payload.fileName ?? "File"} arrived on this PC.`
        );
      }
      if (event.type === "upload-failed") notify("A transfer needs your attention.", "error");
    });
  }, [notify, refresh]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      } else if (event.key === "Escape") {
        setCommandOpen(false);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const completeOnboarding = async () => {
    await api.setOnboardingComplete();
    setOnboarding(false);
  };

  const updateSettings = async (patch: Partial<AppSettings>, message?: string) => {
    if (!snapshot) return;
    const optimistic = { ...snapshot, settings: { ...snapshot.settings, ...patch } };
    setSnapshot(optimistic);
    if (patch.theme) document.documentElement.dataset.theme = patch.theme;
    if (patch.interfaceDensity) document.documentElement.dataset.density = patch.interfaceDensity;
    if (patch.highContrast !== undefined) {
      document.documentElement.dataset.contrast = patch.highContrast ? "high" : "normal";
    }
    if (patch.interfaceScale) {
      document.documentElement.style.setProperty("--interface-scale", String(patch.interfaceScale));
    }
    if (patch.language) document.documentElement.lang = resolvedLanguage(patch.language);
    try {
      setSnapshot(await api.updateSettings(patch));
      if (message) notify(message);
    } catch (error) {
      setSnapshot(snapshot);
      notify(error instanceof Error ? error.message : "Setting could not be saved.", "error");
    }
  };

  const shareFiles = async (expiresMinutes = 0) => {
    const next = await api.shareFiles(expiresMinutes);
    if (next) {
      setSnapshot(next);
      notify("Ready for your iPhone to download.");
    } else {
      notify("No files were selected. The iPhone share list was not changed.", "info");
    }
  };

  const chooseDestination = async () => {
    const next = await api.chooseDestination();
    if (next) {
      setSnapshot(next);
      notify("Save location updated.");
    } else {
      notify("Save location selection canceled. The current folder was kept.", "info");
    }
  };

  const rotatePin = async () => {
    setSnapshot(await api.refreshPairingCode());
    setQrCode(null);
    setQrCode(await api.getQrCode());
    notify("A fresh pairing code is ready.", "info");
  };

  const copyLink = async () => {
    await api.copyConnectionLink();
    notify("Connection link copied.");
  };

  const revealTransfer = (id: string) => void api.revealTransfer(id);

  const filteredHistory = useMemo(() => {
    if (!snapshot) return [];
    const query = search.toLocaleLowerCase();
    return snapshot.history.filter((item) => {
      const extension = item.fileName.split(".").pop()?.toLocaleLowerCase() ?? "";
      const age = Date.now() - new Date(item.createdAt).getTime();
      const matchesFilter =
        statusFilter === "all" ||
        (statusFilter === "favorite" && item.favorite) ||
        (statusFilter === "recent" && age <= 7 * 24 * 60 * 60 * 1_000) ||
        (statusFilter === "large" && item.size >= 100 * 1024 * 1024) ||
        (statusFilter === "music" &&
          ["wav", "mp3", "flac", "m4a", "aac", "aiff"].includes(extension)) ||
        (statusFilter === "photos" &&
          ["jpg", "jpeg", "png", "heic", "webp", "gif"].includes(extension)) ||
        item.status === statusFilter;
      return (
        matchesFilter &&
        (!query ||
          item.fileName.toLocaleLowerCase().includes(query) ||
          item.sourceDevice.toLocaleLowerCase().includes(query) ||
          item.note?.toLocaleLowerCase().includes(query) ||
          item.tags?.some((tag) => tag.toLocaleLowerCase().includes(query)))
      );
    });
  }, [search, snapshot, statusFilter]);

  const mediaPlayerTracks = useMemo<AudioPreviewTrack[]>(() => {
    if (!snapshot) return [];
    const localMusic = [...snapshot.musicLibrary]
      .sort((left, right) => {
        const leftDocRoshi = left.relativeFolder
          .toLocaleLowerCase()
          .split(/[\\/]/)
          .includes("docroshi beats");
        const rightDocRoshi = right.relativeFolder
          .toLocaleLowerCase()
          .split(/[\\/]/)
          .includes("docroshi beats");
        return (
          Number(rightDocRoshi) - Number(leftDocRoshi) ||
          (left.title || left.fileName).localeCompare(right.title || right.fileName, undefined, {
            sensitivity: "base"
          })
        );
      })
      .map<AudioPreviewTrack>((item) => ({
        id: musicPlayerId(item.id),
        kind: "audio",
        title: item.title.trim() || item.fileName.replace(/\.[^.]+$/, ""),
        artist: item.artist.trim() || "Unknown artist",
        album: item.album.trim() || item.relativeFolder || item.source,
        durationSeconds: item.durationSeconds
      }));

    const recentGalleryMedia = snapshot.history
      .filter((item) => item.status === "completed" && item.savedPath && item.size > 0)
      .slice(0, 80)
      .flatMap<AudioPreviewTrack>((item) => {
        const kind = detectMediaKind(item.fileName, item.mimeType);
        if (!isPlayableMediaKind(kind)) return [];
        return [{
          id: transferPlayerId(item.id),
          kind,
          title: item.fileName.replace(/\.[^.]+$/, ""),
          artist: kind === "gif" ? "Animated GIF" : `${kind === "video" ? "Video" : "Audio"} from ${item.sourceDevice}`,
          album: `Recent Gallery · ${formatDate(item.completedAt ?? item.createdAt)}`,
          posterUrl: mediaPlayerPosters[transferPlayerId(item.id)]
        }];
      });

    return [...localMusic, ...recentGalleryMedia];
  }, [mediaPlayerPosters, snapshot?.history, snapshot?.musicLibrary]);

  const resolveMediaPlayerSource = useCallback(async (
    track: AudioPreviewTrack,
    signal: AbortSignal
  ) => {
    const source = playerSourceId(track.id);
    if (!source) throw new Error("PocketDock could not identify this local media item.");
    if (signal.aborted) throw new DOMException("Preview request cancelled.", "AbortError");
    const url = source.scope === "music"
      ? await api.getMusicPlaybackUrl(source.id)
      : await api.getTransferPlaybackUrl(source.id);
    if (signal.aborted) throw new DOMException("Preview request cancelled.", "AbortError");
    return url;
  }, []);

  const updateMediaPlayerSummary = useCallback((next: AudioPlayerSnapshot) => {
    setMediaPlayerSummary((current) => {
      if (
        current.currentTrackId === next.currentTrackId &&
        current.status === next.status &&
        current.isPlaying === next.isPlaying &&
        current.error === next.error
      ) {
        return current;
      }
      return {
        currentTrackId: next.currentTrackId,
        status: next.status,
        isPlaying: next.isPlaying,
        error: next.error
      };
    });
  }, []);

  const previewMedia = useCallback((
    trackId: string,
    queueTrackIds: readonly string[],
    posterUrl?: string
  ) => {
    if (posterUrl) {
      setMediaPlayerPosters((current) => current[trackId] === posterUrl
        ? current
        : { ...current, [trackId]: posterUrl });
    }
    const player = mediaPlayerRef.current;
    if (!player) return;
    if (mediaPlayerSummary.currentTrackId === trackId) {
      player.replaceQueue(queueTrackIds);
      player.toggleTrack(trackId);
      return;
    }
    player.replaceQueue(queueTrackIds, trackId);
    player.focus();
  }, [mediaPlayerSummary.currentTrackId]);

  const reportMediaPlayerError = useCallback((message: string, track: AudioPreviewTrack | null) => {
    notify(track ? `${track.title}: ${message}` : message, "error");
  }, [notify]);

  if (!snapshot) {
    return (
      <div className="loading-screen">
        <Logo />
        <div className="loader" />
        <span>Starting your private file bridge…</span>
      </div>
    );
  }

  const completed = snapshot.history.filter((item) => item.status === "completed");
  const totalMoved = completed.reduce((sum, item) => sum + item.size, 0);
  const storagePercent = snapshot.storage
    ? Math.min(100, (snapshot.storage.used / snapshot.storage.total) * 100)
    : 0;
  const recognizedUsbDevices = snapshot.usbDevices.filter((device) => device.driverDetected);
  const primaryUsbDevice = recognizedUsbDevices[0];
  const phoneInventoryItemCount = snapshot.phoneMusicLibraries.reduce(
    (sum, library) =>
      sum + library.music.length + library.files.length + getPhoneMusicCollections(library).length,
    0
  );
  const musicBrowserItemCount = snapshot.musicLibrary.length + phoneInventoryItemCount;
  const t = (value: string) => translate(value, snapshot.settings.language);
  const pageTitles: Record<Page, { title: string; subtitle: string }> = {
    music: { title: "Music Library", subtitle: "Windows audio plus the complete cached iPhone library and recovery inventory." },
    home: { title: t("Good to see you, Doc."), subtitle: t("Your iPhone bridge is ready.") },
    transfers: { title: t("Transfer history"), subtitle: t("Everything that moved through PocketDock.") },
    gallery: { title: t("Media gallery"), subtitle: t("Preview photos, videos, documents, and audio.") },
    share: { title: t("Send to iPhone"), subtitle: t("Make PC files available in your iPhone browser.") },
    links: { title: t("Private links"), subtitle: t("Encrypted, expiring downloads with hard limits.") },
    requests: { title: "File Requests", subtitle: "Collect files directly into an approved PC folder." },
    drive: { title: "PocketDock Drive", subtitle: "Browse approved PC files from your trusted iPhone." },
    sync: { title: t("Sync & backup"), subtitle: t("Automatic folders, Camera Roll profiles, and remote access.") },
    studio: { title: t("Producer Studio"), subtitle: t("Package beats, stems, artwork, and project files.") },
    clipboard: { title: t("Shared clipboard"), subtitle: t("Move text and links between devices.") },
    usb: { title: t("USB photo import"), subtitle: t("Import Camera Roll items over a cable.") },
    vault: { title: t("Encrypted vault"), subtitle: t("Files protected at rest with your passphrase.") },
    storage: { title: "Storage Intelligence", subtitle: "Find duplicates and reclaim space without guesswork." },
    recovery: { title: "Recovery Center", subtitle: "Repair interrupted transfers and unavailable paths safely." },
    settings: { title: t("Settings"), subtitle: t("Make PocketDock work your way.") }
  };

  return (
    <div className={`app-shell ${mediaPlayerTracks.length ? "has-media-player" : ""}`}>
      <div className="window-drag-region">
        <Logo />
      </div>
      <aside className={sidebarOpen ? "open" : ""}>
        <div className="sidebar-spacer" />
        <nav aria-label="Main navigation">
          <button className={page === "music" ? "active" : ""} onClick={() => setPage("music")}>
            <Music2 size={19} /> <span>Music Library</span>
            <em title={`${musicBrowserItemCount} Windows and cached iPhone item${musicBrowserItemCount === 1 ? "" : "s"}`}>
              {musicBrowserItemCount}
            </em>
          </button>
          <button className={page === "home" ? "active" : ""} onClick={() => setPage("home")}>
            <Gauge size={19} /> <span>{t("Home")}</span>
          </button>
          <button
            className={page === "transfers" ? "active" : ""}
            onClick={() => setPage("transfers")}
          >
            <History size={19} /> <span>{t("Transfers")}</span>
            {snapshot.activeTransfers.length > 0 && (
              <em>{snapshot.activeTransfers.length}</em>
            )}
          </button>
          <button className={page === "gallery" ? "active" : ""} onClick={() => setPage("gallery")}>
            <Images size={19} /> <span>{t("Gallery")}</span>
          </button>
          <button className={page === "share" ? "active" : ""} onClick={() => setPage("share")}>
            <UploadCloud size={19} /> <span>{t("Send to iPhone")}</span>
          </button>
          <button className={page === "links" ? "active" : ""} onClick={() => setPage("links")}>
            <Link2 size={19} /> <span>{t("Private Links")}</span>
          </button>
          <button className={page === "requests" ? "active" : ""} onClick={() => setPage("requests")}>
            <Inbox size={19} /> <span>File Requests</span>
            {snapshot.fileRequestUploads.filter((item) => item.status === "pending").length > 0 && (
              <em>{snapshot.fileRequestUploads.filter((item) => item.status === "pending").length}</em>
            )}
          </button>
          <button className={page === "drive" ? "active" : ""} onClick={() => setPage("drive")}>
            <FolderOpen size={19} /> <span>PocketDock Drive</span>
          </button>
          <button className={page === "sync" ? "active" : ""} onClick={() => setPage("sync")}>
            <FolderSync size={19} /> <span>{t("Sync & Backup")}</span>
          </button>
          <button className={page === "studio" ? "active" : ""} onClick={() => setPage("studio")}>
            <Music2 size={19} /> <span>{t("Producer Studio")}</span>
          </button>
          <button
            className={page === "clipboard" ? "active" : ""}
            onClick={() => setPage("clipboard")}
          >
            <Clipboard size={19} /> <span>{t("Clipboard")}</span>
            {snapshot.clipboardEntries.length > 0 && <em>{snapshot.clipboardEntries.length}</em>}
          </button>
          <button className={page === "usb" ? "active" : ""} onClick={() => setPage("usb")}>
            <Usb size={19} /> <span>{t("USB Files")}</span>
            {recognizedUsbDevices.length > 0 && (
              <em title={`${recognizedUsbDevices.length} iPhone USB connection${recognizedUsbDevices.length === 1 ? "" : "s"} detected`}>
                {recognizedUsbDevices.length}
              </em>
            )}
          </button>
          <button className={page === "vault" ? "active" : ""} onClick={() => setPage("vault")}>
            <LockKeyhole size={19} /> <span>{t("Vault")}</span>
          </button>
          <button className={page === "storage" ? "active" : ""} onClick={() => setPage("storage")}>
            <Layers3 size={19} /> <span>Storage</span>
          </button>
          <button className={page === "recovery" ? "active" : ""} onClick={() => setPage("recovery")}>
            <ArchiveRestore size={19} /> <span>Recovery</span>
            {snapshot.recoveryIssues.some((item) => item.severity === "critical") && <em>!</em>}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button
            className={page === "settings" ? "active" : ""}
            onClick={() => setPage("settings")}
          >
            <Settings size={19} /> <span>{t("Settings")}</span>
          </button>
          <div className="privacy-note">
            <img src="./branding/pocketdock_badge_mark.png" alt="" />
            <div>
              <strong>{t("Local & private")}</strong>
              <span>{t("Nothing goes to the cloud")}</span>
            </div>
          </div>
          <div className="version">PocketDock {snapshot.version}</div>
        </div>
      </aside>

      <main>
        <header className="page-header">
          <button
            className="mobile-menu icon-button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Open navigation"
          >
            <Menu size={20} />
          </button>
          <div>
            <h1>{pageTitles[page].title}</h1>
            <p>{pageTitles[page].subtitle}</p>
          </div>
          <button
            className="command-trigger"
            onClick={() => setCommandOpen(true)}
            aria-label="Open quick switcher"
          >
            <Search size={15} />
            <span>Quick switcher</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div
            className={`connection-pill ${primaryUsbDevice || snapshot.connection.running ? "online" : ""}`}
            title={
              primaryUsbDevice
                ? `${primaryUsbDevice.name} is physically connected over USB${primaryUsbDevice.dcimDetected ? " and its Camera Roll is ready" : "; Camera Roll access is not ready yet"}.`
                : undefined
            }
          >
            <span />
            {primaryUsbDevice
              ? `${primaryUsbDevice.name} detected`
              : snapshot.connection.running
                ? t("Ready to connect")
                : t("Offline")}
          </div>
        </header>

        <div className="page-content">
          {page === "music" && (
            <MusicLibraryPage
              items={snapshot.musicLibrary}
              phoneLibraries={snapshot.phoneMusicLibraries}
              customDirectories={snapshot.settings.customMusicDirectories}
              playerSummary={mediaPlayerSummary}
              onPreview={previewMedia}
              onOpenUsb={() => setPage("usb")}
              onRefresh={async () => {
                try {
                  setSnapshot(await api.refreshMusicLibrary());
                  notify("Local Windows music folders refreshed.", "info");
                } catch (error) {
                  notify(
                    error instanceof Error ? error.message : "The local music library could not be refreshed.",
                    "error"
                  );
                }
              }}
              onReveal={async (id) => {
                try {
                  await api.revealMusicFile(id);
                } catch (error) {
                  notify(
                    error instanceof Error ? error.message : "The music file could not be shown in Explorer.",
                    "error"
                  );
                }
              }}
              onAddDirectory={async () => {
                const next = await api.addMusicDirectory();
                if (next) {
                  setSnapshot(next);
                  notify("Music folder added and indexed.");
                } else {
                  notify("No music folder was added.", "info");
                }
              }}
              onRemoveDirectory={async (directory) => {
                setSnapshot(await api.removeMusicDirectory(directory));
                notify("Music folder removed from the index. Files on disk were not deleted.", "info");
              }}
            />
          )}
          {page === "home" && (
            <Dashboard
              snapshot={snapshot}
              qrCode={qrCode}
              totalMoved={totalMoved}
              storagePercent={storagePercent}
              onCopyLink={copyLink}
              onRotatePin={rotatePin}
              onRepairConnection={async () => {
                try {
                  notify(await api.configureFirewall(), "info");
                  await refresh();
                } catch (error) {
                  notify(
                    error instanceof Error
                      ? error.message
                      : "Windows access could not be repaired.",
                    "error"
                  );
                }
              }}
              onOpenFolder={() => void api.openDestination()}
              onShareFiles={shareFiles}
              onOpenUsb={() => setPage("usb")}
              onShowAll={() => setPage("transfers")}
              onReveal={revealTransfer}
              onPause={async (id) => setSnapshot(await api.pauseTransfer(id))}
              onResume={async (id) => setSnapshot(await api.resumeTransfer(id))}
              onCancel={async (id) => {
                const transfer = snapshot.activeTransfers.find((item) => item.id === id);
                if (!window.confirm(
                  `Cancel ${transfer?.fileName ? `“${transfer.fileName}”` : "this transfer"}? Its resumable staging data will be removed.`
                )) return;
                setSnapshot(await api.cancelTransfer(id));
                notify("Transfer cancelled.", "info");
              }}
            />
          )}
          {page === "transfers" && (
            <TransfersPage
              history={filteredHistory}
              allHistory={snapshot.history}
              search={search}
              filter={statusFilter}
              onSearch={setSearch}
              onFilter={setStatusFilter}
              onReveal={revealTransfer}
              onUpdate={async (id, patch) => {
                setSnapshot(await api.updateTransferMetadata(id, patch));
                notify("Transfer details saved.");
              }}
              onUpdateBulk={async (ids, patch) => {
                setSnapshot(await api.updateTransfersMetadata(ids, patch));
                notify(`${ids.length} transfer${ids.length === 1 ? "" : "s"} updated.`);
              }}
              onAddTag={async (ids, tag) => {
                setSnapshot(await api.addTagToTransfers(ids, tag));
                notify(`Tag added to ${ids.length} transfer${ids.length === 1 ? "" : "s"}.`);
              }}
              onShareSelected={async (ids, expiresMinutes) => {
                try {
                  setSnapshot(await api.shareTransfers(ids, expiresMinutes));
                  notify(`${ids.length} selected transfer${ids.length === 1 ? "" : "s"} ready for iPhone.`);
                  return true;
                } catch (error) {
                  notify(error instanceof Error ? error.message : "Selected files could not be shared.", "error");
                  return false;
                }
              }}
              onVaultSelected={async (ids) => {
                try {
                  setSnapshot(await api.vaultTransfers(ids));
                  notify(`${ids.length} selected transfer${ids.length === 1 ? "" : "s"} encrypted in Vault.`);
                  return true;
                } catch (error) {
                  notify(error instanceof Error ? error.message : "Unlock Vault before adding files.", "error");
                  return false;
                }
              }}
              onClear={async () => {
                setSnapshot(await api.clearHistory());
                notify("Transfer history cleared.", "info");
              }}
            />
          )}
          {page === "gallery" && (
            <GalleryPage
              history={snapshot.history}
              playerSummary={mediaPlayerSummary}
              onPreview={previewMedia}
              onReveal={revealTransfer}
            />
          )}
          {page === "share" && (
            <SharePage
              files={snapshot.sharedFiles}
              connected={snapshot.connection.connectedDevices}
              onAdd={shareFiles}
              onRemove={async (id) => {
                setSnapshot(await api.removeSharedFile(id));
                notify("File removed from your iPhone share list.", "info");
              }}
              onGoHome={() => setPage("home")}
              onDrop={async (files, expiresMinutes) => {
                setSnapshot(await api.shareDroppedFiles(files, expiresMinutes));
                notify(`${files.length} ${files.length === 1 ? "file" : "files"} ready for iPhone.`);
              }}
            />
          )}
          {page === "links" && (
            <PrivateLinksPage
              files={snapshot.sharedFiles}
              links={snapshot.privateShareLinks}
              onCreate={async (name, ids, hours, maximum) => {
                setSnapshot(await api.createPrivateShareLink(name, ids, hours, maximum));
                notify("Encrypted private link created.");
              }}
              onCopy={async (id) => {
                await api.copyPrivateShareLink(id);
                notify("Private link copied.");
              }}
              onQr={(id) => api.getPrivateShareQrCode(id)}
              onSaveQr={async (id) => notify(await api.savePrivateShareQrCode(id), "info")}
              onRevoke={async (id) => {
                setSnapshot(await api.revokePrivateShareLink(id));
                notify("Private link revoked.", "info");
              }}
              onAddFiles={shareFiles}
            />
          )}
          {page === "requests" && (
            <FileRequestsPage
              requests={snapshot.fileRequests}
              uploads={snapshot.fileRequestUploads}
              onCreate={async (details) => {
                setSnapshot(await api.createFileRequest(details));
                notify("Private file request created.");
              }}
              onCopy={async (id) => {
                await api.copyFileRequestLink(id);
                notify("File request link copied.");
              }}
              onQr={(id) => api.getFileRequestQrCode(id)}
              onSaveQr={async (id) => notify(await api.saveFileRequestQrCode(id), "info")}
              onRevoke={async (id) => {
                setSnapshot(await api.revokeFileRequest(id));
                notify("File request revoked.", "info");
              }}
              onApprove={async (id) => {
                setSnapshot(await api.approveFileRequestUpload(id));
                notify("Requested file approved and moved into your library.");
              }}
              onReject={async (id) => {
                setSnapshot(await api.rejectFileRequestUpload(id));
                notify("Requested file rejected.", "info");
              }}
            />
          )}
          {page === "drive" && (
            <DrivePage
              key={snapshot.settings.remoteBrowseRoot}
              settings={snapshot.settings}
              transport={snapshot.transportStatus}
              onUpdateSettings={updateSettings}
              onChooseRoot={async () => {
                const next = await api.chooseRemoteBrowseRoot();
                if (next) {
                  setSnapshot(next);
                  notify("PocketDock Drive root updated.");
                } else {
                  notify("Drive root was not changed.", "info");
                }
              }}
              onChanged={refresh}
            />
          )}
          {page === "sync" && (
            <SyncPage
              settings={snapshot.settings}
              profiles={snapshot.syncProfiles}
              watchFolders={snapshot.watchFolders}
              remote={snapshot.remoteStatus}
              onUpdateSettings={updateSettings}
              onAddProfile={async () => {
                const next = await api.addSyncProfile();
                if (next) {
                  setSnapshot(next);
                  notify("Sync profile added.");
                } else {
                  notify("Sync profile creation canceled. No folder was added.", "info");
                }
              }}
              onUpdateProfile={async (id, patch) =>
                setSnapshot(await api.updateSyncProfile(id, patch))
              }
              onRemoveProfile={async (id) =>
                setSnapshot(await api.removeSyncProfile(id))
              }
              onRunProfile={async (id) => {
                setSnapshot(await api.runSyncProfile(id));
                notify("Sync scan complete.");
              }}
              onAddWatchFolder={async () => {
                const next = await api.addWatchFolder();
                if (next) {
                  setSnapshot(next);
                  notify("Watch folder added.");
                } else {
                  notify("Watch folder selection canceled. Nothing was added.", "info");
                }
              }}
              onUpdateWatchFolder={async (id, patch) =>
                setSnapshot(await api.updateWatchFolder(id, patch))
              }
              onRemoveWatchFolder={async (id) =>
                setSnapshot(await api.removeWatchFolder(id))
              }
              onScanWatchFolders={async () => {
                setSnapshot(await api.scanWatchFolders());
                notify("Watch folders scanned.");
              }}
            />
          )}
          {page === "studio" && (
            <StudioPage
              packages={snapshot.producerPackages}
              onCreate={async (details) => {
                const next = await api.createProducerPackage(details);
                if (next) {
                  setSnapshot(next);
                  notify("Producer delivery packaged and shared.");
                  return true;
                }
                notify("Producer package canceled. Your delivery details were kept.", "info");
                return false;
              }}
            />
          )}
          {page === "clipboard" && (
            <ClipboardPage
              entries={snapshot.clipboardEntries}
              onCopy={async (id) => {
                await api.copyClipboardEntry(id);
                notify("Copied to Windows clipboard.");
              }}
              onSend={async (content) => {
                setSnapshot(await api.sendClipboardText(content));
                notify("Clipboard item shared.");
              }}
              onCapture={async () => {
                setSnapshot(await api.sendClipboardText());
                notify("Current Windows clipboard shared.");
              }}
              onClear={async () => {
                setSnapshot(await api.clearClipboard());
                notify("Shared clipboard cleared.", "info");
              }}
            />
          )}
          {page === "usb" && (
            <UsbPage
              devices={snapshot.usbDevices}
              importEnabled={snapshot.settings.allowUsbImport}
              onRefresh={async () => {
                const next = await api.refreshUsbDevices();
                setSnapshot(next);
                const recognized = next.usbDevices.filter((device) => device.driverDetected).length;
                const ready = next.usbDevices.filter((device) => device.dcimDetected).length;
                const message = recognized
                  ? `USB scan complete: ${recognized} iPhone connection${recognized === 1 ? "" : "s"} recognized · ${ready} Camera Roll${ready === 1 ? "" : "s"} ready.`
                  : "USB scan complete: no Apple device was detected.";
                notify(message, "info");
                return { message, tone: "info" };
              }}
              onImport={async (id) => {
                const response = await api.importUsbPhotos(id);
                setSnapshot(response.snapshot);
                const { imported, skipped, failed } = response.result;
                const message =
                  `${imported} new item${imported === 1 ? "" : "s"} imported` +
                  ` · ${skipped} already present · ${failed} failed.`;
                const tone = failed ? "error" : "success";
                notify(message, tone);
                return { message, tone };
              }}
              onOpenAppleDevices={async () => {
                const message = await api.openAppleDevices();
                notify(message, "info");
                return { message, tone: "info" };
              }}
            />
          )}
          {page === "vault" && (
            <VaultPage
              items={snapshot.vaultItems}
              unlocked={snapshot.vaultUnlocked}
              initialized={snapshot.vaultInitialized}
              onInitialize={async (passphrase) => {
                setSnapshot(await api.initializeVault(passphrase));
                notify("Encrypted vault initialized.");
              }}
              onUnlock={async (passphrase) => {
                setSnapshot(await api.unlockVault(passphrase));
                notify("Vault unlocked.");
              }}
              onLock={async () => {
                setSnapshot(await api.lockVault());
                notify("Vault locked.", "info");
              }}
              onAdd={async () => {
                const next = await api.addFilesToVault();
                if (next) {
                  setSnapshot(next);
                  notify("Files encrypted in the vault.");
                } else {
                  notify("No files were selected for the vault.", "info");
                }
              }}
              onExport={async (id) => {
                const exported = await api.exportVaultItem(id);
                notify(
                  exported ? "Vault item decrypted, verified, and shown in Explorer." : "Vault export canceled.",
                  exported ? "success" : "info"
                );
              }}
              onRemove={async (id) => {
                setSnapshot(await api.removeVaultItem(id));
                notify("Vault item permanently removed.", "info");
              }}
            />
          )}
          {page === "storage" && (
            <StorageIntelligencePage
              groups={snapshot.duplicateGroups}
              onScan={async () => {
                setSnapshot(await api.refreshDuplicateGroups());
                notify("Duplicate scan complete.", "info");
              }}
              onTrash={async (ids) => {
                const result = await api.trashDuplicateTransfers(ids);
                setSnapshot(result.snapshot);
                if (result.failed.length) {
                  notify(
                    `${result.trashed} file${result.trashed === 1 ? "" : "s"} recycled · ${result.failed.length} could not be moved and remain in the library.`,
                    "error"
                  );
                } else {
                  notify(`${result.trashed} duplicate file${result.trashed === 1 ? "" : "s"} moved to the Recycle Bin.`);
                }
              }}
            />
          )}
          {page === "recovery" && (
            <RecoveryCenterPage
              issues={snapshot.recoveryIssues}
              snapshots={snapshot.backupSnapshots}
              service={snapshot.backgroundService}
              onScan={async () => {
                setSnapshot(await api.refreshRecoveryIssues());
                notify("Recovery scan complete.", "info");
              }}
              onResolve={async (id) => {
                setSnapshot(await api.resolveRecoveryIssue(id));
                notify("Recovery action completed.");
              }}
              onCreateSnapshot={async () => {
                try {
                  setSnapshot(await api.createBackupSnapshot());
                  notify("Verified restore point created.");
                } catch (error) {
                  notify(error instanceof Error ? error.message : "Restore point could not be created.", "error");
                }
              }}
              onRestoreSnapshot={async (id) => {
                try {
                  setSnapshot(await api.restoreBackupSnapshot(id));
                  notify("Restore completed in a new folder.");
                } catch (error) {
                  notify(error instanceof Error ? error.message : "Restore could not be completed.", "error");
                }
              }}
              onService={async (enabled) => {
                try {
                  setSnapshot(await api.setBackgroundService(enabled));
                  notify(enabled ? "Background service installed." : "Background service removed.");
                } catch (error) {
                  notify(error instanceof Error ? error.message : "Background service could not be changed.", "error");
                }
              }}
            />
          )}
          {page === "settings" && (
            <SettingsPage
              settings={snapshot.settings}
              connection={snapshot.connection}
              trustedDevices={snapshot.trustedDevices}
              rules={snapshot.automationRules}
              onChooseDestination={chooseDestination}
              onUpdate={updateSettings}
              onRotatePin={rotatePin}
              onOpenOnboarding={() => setOnboarding(true)}
              onRevokeDevice={async (id) => {
                setSnapshot(await api.revokeTrustedDevice(id));
                notify("Trusted device revoked.", "info");
              }}
              onUpdateDevicePermissions={async (id, permissions) => {
                setSnapshot(await api.updateTrustedDevicePermissions(id, permissions));
                notify("Device permissions updated.");
              }}
              onAddRule={async (rule) => {
                setSnapshot(await api.addAutomationRule(rule));
                notify("Automation rule added.");
              }}
              onRemoveRule={async (id) => {
                setSnapshot(await api.removeAutomationRule(id));
                notify("Automation rule removed.", "info");
              }}
              onInstallExplorer={async () => {
                const installed = await api.installExplorerIntegration();
                notify(installed ? "Explorer integration installed." : "Available in Windows builds.", "info");
              }}
              onConfigureFirewall={async () => notify(await api.configureFirewall(), "info")}
              onRunDiagnostics={() => api.runDiagnostics()}
              onExportDiagnostics={async () => notify(await api.exportDiagnostics(), "info")}
              onCheckUpdates={async () => notify(await api.checkForUpdates(), "info")}
            />
          )}
        </div>
        {mediaPlayerTracks.length > 0 && (
          <div className="media-player-dock">
            <AudioPreviewPlayer
              ref={mediaPlayerRef}
              className="pocketdock-media-player"
              tracks={mediaPlayerTracks}
              resolveSource={resolveMediaPlayerSource}
              persistenceKey="pocketdock:media-preview-player:v1"
              globalKeyboardShortcuts
              keyboardShortcutsEnabled={!commandOpen && !onboarding}
              emptyMessage="Choose Play on a Music Library or Gallery item to preview it."
              onStateChange={updateMediaPlayerSummary}
              onError={reportMediaPlayerError}
            />
          </div>
        )}
      </main>

      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      {commandOpen && (
        <CommandPalette
          onClose={() => setCommandOpen(false)}
          onNavigate={(nextPage) => {
            setPage(nextPage);
            setSidebarOpen(false);
          }}
          onShare={() => void shareFiles()}
          onOpenFolder={() => void api.openDestination()}
        />
      )}
      {onboarding && <Onboarding onDone={completeOnboarding} />}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.tone === "success" ? (
              <CheckCircle2 size={18} />
            ) : toast.tone === "error" ? (
              <Info size={18} />
            ) : (
              <Wifi size={18} />
            )}
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

type MusicSourceFilter = "all" | "windows" | "iphone";
type MusicKindFilter =
  | "all"
  | "docroshi"
  | "phone-audio"
  | "phone-files"
  | "phone-collections"
  | "apple-music"
  | "windows-audio";
type MusicBrowserEntry =
  | {
      key: string;
      source: "windows";
      kind: "windows-audio";
      sortName: string;
      searchText: string;
      isDocRoshi: boolean;
      item: MusicLibraryItem;
    }
  | {
      key: string;
      source: "iphone";
      kind: "phone-file";
      sortName: string;
      searchText: string;
      library: PhoneMusicLibrary;
      file: PhoneDocumentFile;
    }
  | {
      key: string;
      source: "iphone";
      kind: "phone-collection";
      sortName: string;
      searchText: string;
      library: PhoneMusicLibrary;
      collection: PhoneMusicCollection;
    }
  | {
      key: string;
      source: "iphone";
      kind: "apple-music";
      sortName: string;
      searchText: string;
      library: PhoneMusicLibrary;
      track: PhoneMusicTrack;
      collectionNames: string[];
    };

// The library is intentionally expanded on load so every indexed song is immediately searchable
// and visible without another click. Rows use CSS content-visibility to keep long libraries smooth.
const MUSIC_LIBRARY_PAGE_SIZE = Number.MAX_SAFE_INTEGER;

function MusicLibraryPage({
  items,
  phoneLibraries,
  customDirectories,
  playerSummary,
  onPreview,
  onRefresh,
  onReveal,
  onOpenUsb,
  onAddDirectory,
  onRemoveDirectory
}: {
  items: MusicLibraryItem[];
  phoneLibraries: PhoneMusicLibrary[];
  customDirectories: string[];
  playerSummary: MediaPlayerSummary;
  onPreview: (trackId: string, queueTrackIds: readonly string[], posterUrl?: string) => void;
  onRefresh: () => Promise<void>;
  onReveal: (id: string) => Promise<void>;
  onOpenUsb: () => void;
  onAddDirectory: () => Promise<void>;
  onRemoveDirectory: (directory: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<MusicSourceFilter>("all");
  const [kindFilter, setKindFilter] = useState<MusicKindFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(MUSIC_LIBRARY_PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [directoryAction, setDirectoryAction] = useState<string | null>(null);
  const directoryActionInFlight = useRef(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const totalLocalSize = useMemo(
    () => items.reduce((sum, item) => sum + item.size, 0),
    [items]
  );
  const phoneFiles = useMemo(
    () => phoneLibraries.flatMap((library) => library.files),
    [phoneLibraries]
  );
  const phoneFileSize = useMemo(
    () => phoneFiles.reduce((sum, file) => sum + file.size, 0),
    [phoneFiles]
  );
  const phoneAudioCount = phoneFiles.filter((file) => file.isAudio).length;
  const phoneMusicCount = phoneLibraries.reduce((sum, library) => sum + library.music.length, 0);
  const phoneCollectionCount = phoneLibraries.reduce(
    (sum, library) => sum + getPhoneMusicCollections(library).length,
    0
  );
  const musicFolderCount = items.filter((item) => item.source === "Windows Music").length;
  const documentsFolderCount = items.filter((item) => item.source === "Windows Documents").length;
  const customFolderItemCount = items.filter((item) => item.source === "Windows Custom").length;
  const receivedFolderItemCount = items.filter((item) => item.source === "PocketDock Received").length;
  const docRoshiItemCount = items.filter((item) =>
    item.relativeFolder.toLocaleLowerCase().split(/[\\/]/).includes("docroshi beats")
  ).length;

  const allEntries = useMemo<MusicBrowserEntry[]>(() => {
    const entries: MusicBrowserEntry[] = [];
    for (const library of phoneLibraries) {
      const collections = getPhoneMusicCollections(library);
      const collectionNamesByTrack = new Map<string, string[]>();
      for (const collection of collections) {
        for (const trackId of getPhoneMusicCollectionTrackIds(collection)) {
          const names = collectionNamesByTrack.get(trackId) ?? [];
          names.push(collection.name);
          collectionNamesByTrack.set(trackId, names);
        }
      }
      for (const file of library.files) {
        entries.push({
          key: `phone-file:${library.deviceId}:${file.externalId}`,
          source: "iphone",
          kind: "phone-file",
          sortName: file.name,
          searchText: [
            file.name,
            file.relativePath,
            file.contentType,
            file.isAudio ? "audio" : "document",
            "phone files",
            "PocketDock Documents",
            library.deviceName
          ].filter(Boolean).join("\n").toLocaleLowerCase(),
          library,
          file
        });
      }
      for (const track of library.music) {
        const collectionNames = collectionNamesByTrack.get(track.externalId) ?? [];
        entries.push({
          key: `apple-music:${library.deviceId}:${track.externalId}`,
          source: "iphone",
          kind: "apple-music",
          sortName: track.title,
          searchText: [
            track.title,
            track.artist,
            track.album,
            track.genre,
            track.year,
            ...collectionNames,
            "Apple Music",
            "recovery status",
            library.deviceName
          ].filter((value) => value !== undefined && value !== null).join("\n").toLocaleLowerCase(),
          library,
          track,
          collectionNames
        });
      }
      const tracksById = new Map(library.music.map((track) => [track.externalId, track]));
      for (const collection of collections) {
        const collectionTrackNames = getPhoneMusicCollectionTrackIds(collection)
          .map((trackId) => tracksById.get(trackId)?.title)
          .filter((title): title is string => Boolean(title));
        entries.push({
          key: `phone-collection:${library.deviceId}:${collection.externalId}`,
          source: "iphone",
          kind: "phone-collection",
          sortName: collection.name,
          searchText: [
            collection.name,
            collection.kind,
            `${collection.itemCount} tracks`,
            ...collectionTrackNames,
            "playlist",
            "Music collection",
            library.deviceName
          ].filter(Boolean).join("\n").toLocaleLowerCase(),
          library,
          collection
        });
      }
    }
    for (const item of items) {
      const isDocRoshi = item.relativeFolder
        .toLocaleLowerCase()
        .split(/[\\/]/)
        .includes("docroshi beats");
      entries.push({
        key: `windows:${item.id}`,
        source: "windows",
        kind: "windows-audio",
        sortName: item.title || item.fileName,
        isDocRoshi,
        searchText: [
          item.title,
          item.artist,
          item.album,
          item.fileName,
          item.format,
          item.year,
          item.source,
          item.relativeFolder,
          "Windows PC"
        ].filter((value) => value !== undefined && value !== null).join("\n").toLocaleLowerCase(),
        item
      });
    }
    const priority = (entry: MusicBrowserEntry) => {
      if (entry.kind === "windows-audio" && entry.isDocRoshi) return 0;
      if (entry.kind === "phone-file") return entry.file.isAudio ? 1 : 2;
      if (entry.kind === "phone-collection") return 3;
      if (entry.kind === "apple-music") return 4;
      return 5;
    };
    return entries.sort(
      (left, right) =>
        priority(left) - priority(right) ||
        left.sortName.localeCompare(right.sortName, undefined, { sensitivity: "base" })
    );
  }, [items, phoneLibraries]);

  const filteredEntries = useMemo(
    () =>
      allEntries.filter((entry) => {
        const sourceMatches = sourceFilter === "all" || entry.source === sourceFilter;
        const kindMatches =
          kindFilter === "all" ||
          (kindFilter === "docroshi" && entry.kind === "windows-audio" && entry.isDocRoshi) ||
          (kindFilter === "phone-audio" && entry.kind === "phone-file" && Boolean(entry.file.isAudio)) ||
          (kindFilter === "phone-files" && entry.kind === "phone-file") ||
          (kindFilter === "phone-collections" && entry.kind === "phone-collection") ||
          (kindFilter === "apple-music" && entry.kind === "apple-music") ||
          (kindFilter === "windows-audio" && entry.kind === "windows-audio");
        return sourceMatches && kindMatches && (!normalizedQuery || entry.searchText.includes(normalizedQuery));
      }),
    [allEntries, kindFilter, normalizedQuery, sourceFilter]
  );
  const previewQueueTrackIds = useMemo(
    () => filteredEntries.flatMap((entry) =>
      entry.kind === "windows-audio" ? [musicPlayerId(entry.item.id)] : []
    ),
    [filteredEntries]
  );
  const visibleEntries = filteredEntries.slice(0, visibleLimit);

  useEffect(() => {
    setVisibleLimit(MUSIC_LIBRARY_PAGE_SIZE);
  }, [kindFilter, normalizedQuery, sourceFilter]);

  const refreshLibrary = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const runDirectoryAction = async (key: string, action: () => Promise<void>) => {
    if (directoryActionInFlight.current) return;
    directoryActionInFlight.current = true;
    setDirectoryAction(key);
    try {
      await action();
    } finally {
      directoryActionInFlight.current = false;
      setDirectoryAction(null);
    }
  };

  const authorizationLabel = (library: PhoneMusicLibrary) => {
    const labels: Record<PhoneMusicLibrary["authorization"], string> = {
      authorized: "Music access authorized",
      denied: "Music access denied",
      restricted: "Music access restricted",
      "not-determined": "Music access not requested"
    };
    return labels[library.authorization];
  };

  return (
    <section className="music-library-page" aria-label="Windows and cached iPhone music library">
      <div className="card music-library-overview">
        <div className="music-library-orb"><Music2 size={30} /></div>
        <div className="music-library-intro">
          <span className="eyebrow">Windows library + complete cached phone inventory</span>
          <h2>Your music and PocketDock phone files</h2>
          <p>
            Browse revealable Windows audio, transferable originals in PocketDock Documents,
            and the full iPhone Music inventory. Native PocketDock automatically recovers every
            eligible local, unprotected playlist track and reports the rest by name.
          </p>
          <div className="music-source-chips">
            <span className="music-source-chip"><FolderOpen size={14} /> Windows Music · {musicFolderCount}</span>
            <span className="music-source-chip"><FolderOpen size={14} /> Windows Documents · {documentsFolderCount}</span>
            <span className="music-source-chip phone"><ArrowDownToLine size={14} /> PocketDock Received · {receivedFolderItemCount}</span>
            <span className="music-source-chip phone"><Music2 size={14} /> DocRoshi Beats · {docRoshiItemCount}</span>
            <span className="music-source-chip"><FolderOpen size={14} /> Custom folders · {customFolderItemCount}</span>
            <span className="music-source-chip phone"><Smartphone size={14} /> Phone files · {phoneFiles.length}</span>
            <span className="music-source-chip metadata"><Layers3 size={14} /> Phone playlists · {phoneCollectionCount}</span>
            <span className="music-source-chip metadata"><Music2 size={14} /> Music tracks · {phoneMusicCount}</span>
          </div>
          <span className="music-source-note">
            <Info size={13} /> Phone inventory comes from the native PocketDock app—not from USB—and is cached for the next Windows launch.
          </span>
        </div>
        <button
          className="secondary-button music-refresh-button"
          disabled={refreshing}
          onClick={() => void refreshLibrary()}
        >
          <RefreshCw className={refreshing ? "spinning" : ""} size={16} />
          {refreshing ? "Refreshing…" : "Refresh PC folders"}
        </button>
        <div className="music-library-stats" aria-label="Music and phone file summary">
          <div className="phone-priority"><strong>{phoneAudioCount.toLocaleString()}</strong><span>Transferable phone audio files</span></div>
          <div><strong>{phoneFiles.length.toLocaleString()}</strong><span>All phone files · {formatBytes(phoneFileSize)}</span></div>
          <div><strong>{(phoneMusicCount + phoneCollectionCount).toLocaleString()}</strong><span>Music recovery inventory · {phoneMusicCount} tracks · {phoneCollectionCount} playlists</span></div>
          <div><strong>{items.length.toLocaleString()}</strong><span>Windows audio · {formatBytes(totalLocalSize)}</span></div>
        </div>
      </div>

      <section className="card music-folder-manager">
        <div className="card-heading compact">
          <div>
            <span className="eyebrow">Folders indexed automatically</span>
            <h3>Windows music locations</h3>
            <p>Music and Documents are always included. Add any other folder that contains your songs, beats, or project audio.</p>
          </div>
          <button
            className="primary-button"
            disabled={Boolean(directoryAction)}
            onClick={() => void runDirectoryAction("add", onAddDirectory)}
          >
            {directoryAction === "add" ? <RefreshCw className="spin" size={15} /> : <FolderPlus size={15} />} Add music folder
          </button>
        </div>
        <div className="music-folder-list">
          <div className="music-folder-row built-in">
            <FolderOpen size={17} />
            <span><strong>Windows Music</strong><small>Built in · {musicFolderCount.toLocaleString()} indexed audio files</small></span>
          </div>
          <div className="music-folder-row built-in">
            <FolderOpen size={17} />
            <span><strong>Windows Documents</strong><small>Built in · {documentsFolderCount.toLocaleString()} indexed audio files</small></span>
          </div>
          <div className="music-folder-row built-in">
            <ArrowDownToLine size={17} />
            <span><strong>PocketDock Received</strong><small>Built in · {receivedFolderItemCount.toLocaleString()} recovered and transferred audio files</small></span>
          </div>
          {customDirectories.map((directory) => (
            <div className="music-folder-row" key={directory}>
              <FolderOpen size={17} />
              <span><strong title={directory}>{directory.split(/[\\/]/).filter(Boolean).at(-1) || directory}</strong><small title={directory}>{directory}</small></span>
              <button
                className="icon-button small"
                disabled={Boolean(directoryAction)}
                title="Remove from music index"
                aria-label={`Remove ${directory} from the music index`}
                onClick={() => {
                  if (!window.confirm(`Stop indexing “${directory}”? Audio files on disk will not be deleted.`)) return;
                  void runDirectoryAction(`remove:${directory}`, () => onRemoveDirectory(directory));
                }}
              >
                {directoryAction === `remove:${directory}`
                  ? <RefreshCw className="spin" size={15} />
                  : <Trash2 size={15} />}
              </button>
            </div>
          ))}
          {!customDirectories.length && (
            <p className="settings-empty">
              {docRoshiItemCount > 0
                ? `DocRoshi Beats is already indexed automatically from PocketDock Received (${docRoshiItemCount.toLocaleString()} tracks).`
                : "No extra music folders yet. Add another folder if you keep music outside the automatic locations."}
            </p>
          )}
        </div>
      </section>

      <div className="card phone-inventory-panel">
        <div className="phone-inventory-instruction">
          <div className="phone-inventory-icon"><Send size={23} /></div>
          <div>
            <span className="eyebrow">Phone recovery · original audio</span>
            <h2>Recover the complete iPhone playlist</h2>
            <p>
              Native PocketDock checks the whole <strong>DocRoshi Beats</strong> playlist first,
              stages every local unprotected track iOS makes available, and sends the recovered
              audio through the encrypted queue. Cloud-only, protected, or unavailable items stay
              visible with their reason instead of silently disappearing.
            </p>
          </div>
          <button className="secondary-button" onClick={onOpenUsb}>
            <Usb size={16} /> Cable device tools
          </button>
        </div>
        <p className="phone-usb-note">
          Cable tools only show content Windows or Apple Devices exposes; iOS does not expose the
          Music-app container as a USB file folder.
        </p>

        {phoneLibraries.length === 0 ? (
          <div className="phone-inventory-empty">
            <Smartphone size={22} />
            <div>
              <strong>No cached iPhone inventory yet</strong>
              <span>
                Connect the native PocketDock iPhone app to this PC. A fresh inventory arrives
                with that connection and remains available at future Windows launches.
              </span>
            </div>
          </div>
        ) : (
          <div className="phone-device-list">
            {phoneLibraries.map((library) => {
              const audioFiles = library.files.filter((file) => file.isAudio).length;
              return (
                <article className={`phone-device-inventory ${library.stale ? "stale" : "fresh"}`} key={library.deviceId}>
                  <div className="phone-device-mark"><Smartphone size={20} /></div>
                  <div className="phone-device-copy">
                    <strong>{library.deviceName}</strong>
                    <span title={new Date(library.receivedAt).toLocaleString()}>
                      Last synced {formatDate(library.receivedAt)} · generated on phone {formatDate(library.generatedAt)}
                    </span>
                  </div>
                  <div className="phone-device-badges">
                    <span className={library.stale ? "warning" : "success"}>
                      {library.stale ? <Clock3 size={12} /> : <Check size={12} />}
                      {library.stale ? "Stale cache" : "Fresh cache"}
                    </span>
                    <span className={library.complete ? "success" : "warning"}>
                      {library.complete ? <Check size={12} /> : <AlertTriangle size={12} />}
                      {library.complete ? "Complete" : "Partial"}
                    </span>
                    <span className={library.authorization === "authorized" ? "success" : "neutral"}>
                      {authorizationLabel(library)}
                    </span>
                  </div>
                  <div className="phone-device-counts">
                    <span><strong>{audioFiles.toLocaleString()}</strong> audio files</span>
                    <span><strong>{library.files.length.toLocaleString()}</strong> all files</span>
                    <span><strong>{library.music.length.toLocaleString()}</strong> recovery rows</span>
                    <span><strong>{getPhoneMusicCollections(library).length.toLocaleString()}</strong> playlists</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="card music-library-browser">
        <div className="music-library-toolbar">
          <div>
            <span className="eyebrow">All indexed sources</span>
            <h2>Music and phone files</h2>
            <p>
              Showing {visibleEntries.length.toLocaleString()} of {filteredEntries.length.toLocaleString()} matching entries
              {filteredEntries.length !== allEntries.length ? ` · ${allEntries.length.toLocaleString()} total` : ""}
            </p>
          </div>
          <label className="music-search-box">
            <Search size={17} />
            <input
              type="search"
              value={query}
              placeholder="Search title, artist, file, folder, or device…"
              aria-label="Search music and phone files"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear library search"
                title="Clear search"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            )}
          </label>
        </div>
        <div className="music-library-filters">
          <label>
            <span>Source</span>
            <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as MusicSourceFilter)}>
              <option value="all">All sources</option>
              <option value="windows">Windows PC</option>
              <option value="iphone">iPhone inventory</option>
            </select>
          </label>
          <label>
            <span>Kind</span>
            <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as MusicKindFilter)}>
              <option value="all">All items</option>
              <option value="docroshi">DocRoshi Beats</option>
              <option value="phone-audio">Phone audio files</option>
              <option value="phone-files">All phone files</option>
              <option value="phone-collections">Phone playlists</option>
              <option value="apple-music">Music-app tracks &amp; recovery</option>
              <option value="windows-audio">Windows audio</option>
            </select>
          </label>
          {(sourceFilter !== "all" || kindFilter !== "all" || query) && (
            <button
              className="text-button"
              onClick={() => {
                setSourceFilter("all");
                setKindFilter("all");
                setQuery("");
              }}
            >
              <RotateCcw size={14} /> Clear filters
            </button>
          )}
        </div>

        {allEntries.length === 0 ? (
          <EmptyState icon={<Music2 size={24} />} title="No music or phone inventory found yet">
            Add audio to Windows Music or Documents, or connect native PocketDock on the iPhone
            to send a phone inventory. USB does not expose the iPhone Music-app container.
          </EmptyState>
        ) : filteredEntries.length === 0 ? (
          <EmptyState icon={<Search size={24} />} title="No matching entries">
            Try another search or clear the source and kind filters.
          </EmptyState>
        ) : (
          <>
            <div className="music-track-heading" aria-hidden="true">
              <span>Item</span>
              <span>Source and details</span>
              <span>Duration</span>
              <span>Size</span>
              <span>Actions</span>
            </div>
            <div className="music-track-list">
              {visibleEntries.map((entry) => {
                if (entry.kind === "windows-audio") {
                  const item = entry.item;
                  const playerTrackId = musicPlayerId(item.id);
                  const isActivePreview = playerSummary.currentTrackId === playerTrackId;
                  const isPreviewLoading = isActivePreview && playerSummary.status === "loading";
                  const isPreviewPlaying = isActivePreview && playerSummary.isPlaying;
                  const isPreviewError = isActivePreview && (
                    playerSummary.status === "error" || playerSummary.status === "unavailable"
                  );
                  const displayTitle = item.title.trim() || item.fileName.replace(/\.[^.]+$/, "");
                  const albumDetails = [
                    item.album?.trim() || "Unknown album",
                    item.trackNumber ? `Track ${item.trackNumber}` : undefined,
                    item.year ? String(item.year) : undefined
                  ].filter(Boolean).join(" · ");
                  return (
                    <article
                      className={`music-track-row windows-audio ${isActivePreview ? "active-preview" : ""}`}
                      key={entry.key}
                    >
                      <div className="music-track-icon"><Music2 size={20} /></div>
                      <div className="music-track-identity">
                        <strong title={displayTitle}>{displayTitle}</strong>
                        <span title={item.artist?.trim() || "Unknown artist"}>{item.artist?.trim() || "Unknown artist"}</span>
                        <small title={albumDetails}>{albumDetails}</small>
                      </div>
                      <div className="music-track-file">
                        <strong title={item.fileName}>{item.fileName}</strong>
                        <span className="music-track-location" title={item.relativeFolder}>
                          <em>{item.source}</em>
                          {item.relativeFolder ? item.relativeFolder : "Folder root"}
                        </span>
                        <small>{item.format.toLocaleUpperCase()} · Updated {formatDate(item.modifiedAt)}</small>
                      </div>
                      <span className="music-track-duration">{formatDuration(item.durationSeconds)}</span>
                      <span className="music-track-size">{formatBytes(item.size)}</span>
                      <div className="music-track-actions">
                        <button
                          className={`icon-button small music-preview-button ${isActivePreview ? "active" : ""} ${isPreviewError ? "error" : ""}`}
                          aria-label={
                            isPreviewPlaying
                              ? `Pause ${displayTitle}`
                              : isPreviewLoading
                                ? `Cancel loading ${displayTitle}`
                                : isPreviewError
                                  ? `Retry ${displayTitle}`
                                  : `Play preview of ${displayTitle}`
                          }
                          aria-pressed={isPreviewPlaying}
                          title={isPreviewPlaying ? "Pause preview" : isPreviewError ? "Retry preview" : "Play preview"}
                          onClick={() => onPreview(playerTrackId, previewQueueTrackIds)}
                        >
                          {isPreviewLoading
                            ? <RefreshCw className="spin" size={16} />
                            : isPreviewPlaying
                              ? <Pause size={16} fill="currentColor" />
                              : isPreviewError
                                ? <AlertTriangle size={16} />
                                : <Play size={16} fill="currentColor" />}
                        </button>
                        <button
                          className="icon-button small music-reveal-button"
                          aria-label={`Show ${item.fileName} in Explorer`}
                          title="Show in Explorer"
                          onClick={() => void onReveal(item.id)}
                        >
                          <FolderOpen size={17} />
                        </button>
                      </div>
                    </article>
                  );
                }

                if (entry.kind === "phone-file") {
                  const { file, library } = entry;
                  return (
                    <article className={`music-track-row phone-file ${file.isAudio ? "audio" : "document"}`} key={entry.key}>
                      <div className="music-track-icon">{fileIcon(file.name, 20)}</div>
                      <div className="music-track-identity">
                        <strong title={file.name}>{file.name}</strong>
                        <span>{file.isAudio ? "Audio file · transferable original" : "PocketDock Documents file"}</span>
                        <small title={file.relativePath}>{file.relativePath || "Documents root"}</small>
                      </div>
                      <div className="music-track-file">
                        <strong>{library.deviceName}</strong>
                        <span className="music-track-location"><em>Phone files</em> PocketDock Documents</span>
                        <small>{file.contentType || "File"} · Updated {formatDate(file.modifiedAt)}</small>
                      </div>
                      <span className="music-track-duration">—</span>
                      <span className="music-track-size">{formatBytes(file.size)}</span>
                      <span className="music-access-badge transferable" title="Use Send or Send all audio files to PC in PocketDock on the iPhone">
                        <Send size={12} /> Send on iPhone
                      </span>
                    </article>
                  );
                }

                if (entry.kind === "phone-collection") {
                  const { collection, library } = entry;
                  return (
                    <article className="music-track-row phone-collection" key={entry.key}>
                      <div className="music-track-icon"><Layers3 size={20} /></div>
                      <div className="music-track-identity">
                        <strong title={collection.name}>{collection.name || "Untitled playlist"}</strong>
                        <span>{collection.kind === "playlist" ? "Playlist" : collection.kind}</span>
                        <small>{collection.itemCount.toLocaleString()} track{collection.itemCount === 1 ? "" : "s"}</small>
                      </div>
                      <div className="music-track-file">
                        <strong>{library.deviceName}</strong>
                        <span className="music-track-location"><em>Music app</em> Playlist recovery source</span>
                        <small>PocketDock checks every member of this playlist on the iPhone.</small>
                      </div>
                      <span className="music-track-duration">—</span>
                      <span className="music-track-size">{collection.itemCount.toLocaleString()}</span>
                      <span className="music-access-badge metadata" title="The native iPhone app checks every playlist member for local unprotected audio">
                        <Layers3 size={12} /> Full playlist
                      </span>
                    </article>
                  );
                }

                const { track, library, collectionNames } = entry;
                const trackDetails = [
                  track.album?.trim() || "Unknown album",
                  track.disc ? `Disc ${track.disc}` : undefined,
                  track.track ? `Track ${track.track}` : undefined,
                  track.year ? String(track.year) : undefined
                ].filter(Boolean).join(" · ");
                return (
                  <article className="music-track-row apple-music" key={entry.key}>
                    <div className="music-track-icon"><Music2 size={20} /></div>
                    <div className="music-track-identity">
                      <strong title={track.title}>{track.title || "Untitled track"}</strong>
                      <span title={track.artist || "Unknown artist"}>{track.artist || "Unknown artist"}</span>
                      <small title={trackDetails}>{trackDetails}</small>
                    </div>
                    <div className="music-track-file">
                      <strong>{library.deviceName}</strong>
                      <span className="music-track-location"><em>Music app</em> Recovery checked on iPhone</span>
                      <small>
                        {track.genre || "No genre"}
                        {track.isDownloaded ? " · Downloaded in Music app" : ""}
                        {collectionNames.length ? ` · ${collectionNames.join(" · ")}` : ""}
                      </small>
                    </div>
                    <span className="music-track-duration">{formatDuration(track.duration)}</span>
                    <span className="music-track-size">—</span>
                    <span className="music-access-badge metadata" title="Eligible local, unprotected audio is recovered automatically by native PocketDock; unavailable items remain metadata rows">
                      <Info size={12} /> Recovery status on iPhone
                    </span>
                  </article>
                );
              })}
            </div>
            {visibleEntries.length < filteredEntries.length && (
              <div className="music-show-more">
                <span>
                  {visibleEntries.length.toLocaleString()} shown · {(filteredEntries.length - visibleEntries.length).toLocaleString()} remaining
                </span>
                <button
                  className="secondary-button"
                  onClick={() => setVisibleLimit((limit) => limit + MUSIC_LIBRARY_PAGE_SIZE)}
                >
                  <Plus size={15} /> Show up to {Math.min(MUSIC_LIBRARY_PAGE_SIZE, filteredEntries.length - visibleEntries.length).toLocaleString()} more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Dashboard({
  snapshot,
  qrCode,
  totalMoved,
  storagePercent,
  onCopyLink,
  onRotatePin,
  onRepairConnection,
  onOpenFolder,
  onShareFiles,
  onOpenUsb,
  onShowAll,
  onReveal,
  onPause,
  onResume,
  onCancel
}: {
  snapshot: AppSnapshot;
  qrCode: string | null;
  totalMoved: number;
  storagePercent: number;
  onCopyLink: () => void;
  onRotatePin: () => void;
  onRepairConnection: () => void;
  onOpenFolder: () => void;
  onShareFiles: () => void;
  onOpenUsb: () => void;
  onShowAll: () => void;
  onReveal: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const usbDevice = snapshot.usbDevices.find((device) => device.driverDetected);
  const usbStatus = !snapshot.settings.allowUsbImport
    ? "PocketDock recognizes the phone. USB Camera Roll import is turned off in Settings."
    : usbDevice?.dcimDetected
      ? "Windows Camera Roll access is ready. You can import new photos and videos now."
      : usbDevice?.storageDetected
        ? "Windows sees Internal Storage, but Camera Roll access is not ready yet."
        : usbDevice?.shellDetected
          ? "Windows recognizes the phone. Keep it unlocked while storage access finishes."
          : "The cable connection is recognized. Unlock the iPhone and tap Trust if prompted.";

  return (
    <>
      {usbDevice && (
        <section
          className={`card usb-presence-banner ${usbDevice.dcimDetected ? "ready" : "detected"}`}
          aria-label={`${usbDevice.name} USB connection status`}
        >
          <div className="usb-presence-icon">
            <Smartphone size={25} />
            <span><Check size={11} /></span>
          </div>
          <div className="usb-presence-copy">
            <span className="eyebrow">USB iPhone detected</span>
            <h2>{usbDevice.name} is connected</h2>
            <p>{usbStatus}</p>
            <div className="usb-presence-stages">
              <span className="ready"><Check size={12} /> Phone recognized</span>
              <span className={usbDevice.dcimDetected ? "ready" : "waiting"}>
                {usbDevice.dcimDetected ? <Check size={12} /> : <AlertTriangle size={12} />}
                {usbDevice.dcimDetected ? "Camera Roll ready" : "Camera Roll not ready"}
              </span>
            </div>
          </div>
          <button className="secondary-button" onClick={onOpenUsb}>
            View USB status <ChevronRight size={16} />
          </button>
        </section>
      )}
      <section className="hero-grid">
        <div className="card connection-card">
          <img
            className="connection-brand-watermark"
            src="./branding/pocketdock_unframed_symbol.png"
            alt=""
          />
          <div className="card-heading">
            <div>
              <span className="eyebrow">Connect your iPhone</span>
              <h2>Scan. Choose. Done.</h2>
              <p>Open Camera on your iPhone and point it at this code.</p>
            </div>
            <div className="live-chip">
              <span />
              Live
            </div>
          </div>
          <div className="connection-body">
            <div className="qr-shell">
              {qrCode ? (
                <img src={qrCode} alt="QR code to connect iPhone" />
              ) : (
                <div className="qr-unavailable">
                  <Wifi size={30} />
                  <span>Connect this PC to Wi-Fi</span>
                </div>
              )}
              <div className="qr-corners" />
            </div>
            <div className="connection-steps">
              <div>
                <span>1</span>
                <p>
                  Open <strong>Camera</strong> on your iPhone
                </p>
              </div>
              <div>
                <span>2</span>
                <p>
                  Scan the code and tap the <strong>browser banner</strong>
                </p>
              </div>
              <div>
                <span>3</span>
                <p>
                  Pick from <strong>Photos or Files</strong>
                </p>
              </div>
              <div className="pin-panel">
                <div>
                  <small>Pairing code</small>
                  <strong>{snapshot.connection.pin.slice(0, 3)} {snapshot.connection.pin.slice(3)}</strong>
                </div>
                <button className="icon-button small" onClick={onRotatePin} title="New code">
                  <RefreshCw size={16} />
                </button>
              </div>
              <div className="connection-actions">
                <button className="text-button" onClick={onCopyLink} disabled={!snapshot.connection.url}>
                  <Copy size={15} /> Copy link
                </button>
                <button className="text-button" onClick={onRepairConnection}>
                  <ShieldCheck size={15} /> Repair Windows access
                </button>
              </div>
            </div>
          </div>
          <div className="connection-footer">
            <ShieldCheck size={17} />
            {snapshot.settings.encryptTransfers ? "AES-256 encrypted" : "Transfer encryption disabled"}
            {snapshot.settings.verifyIntegrity ? " and SHA-256 verified" : ""}. Files never pass through the cloud.
          </div>
        </div>

        <div className="side-stack">
          <div className="card active-card">
            <div className="card-heading compact">
              <div>
                <span className="eyebrow">Right now</span>
                <h3>Transfer activity</h3>
              </div>
              <Activity size={20} />
            </div>
            {snapshot.activeTransfers.length ? (
              <div className="active-list">
                {snapshot.activeTransfers.map((item) => {
                  const percent = item.size ? Math.round((item.received / item.size) * 100) : 100;
                  return (
                    <div className="active-transfer" key={item.id}>
                      <div className="active-file">
                        <div className="file-type-icon">{fileIcon(item.fileName)}</div>
                      <div>
                          <strong>{item.fileName}</strong>
                          <span>
                            {item.paused
                              ? "Paused"
                              : `${formatBytes(item.speedBytesPerSecond)}/s · ${
                                  item.etaSeconds ? `${item.etaSeconds}s left` : "calculating"
                                }`}
                          </span>
                        </div>
                        <em>{percent}%</em>
                        <div className="active-actions">
                          <button
                            className="icon-button small"
                            onClick={() => item.paused ? onResume(item.id) : onPause(item.id)}
                            title={item.paused ? "Resume" : "Pause"}
                          >
                            {item.paused ? <Play size={14} /> : <Pause size={14} />}
                          </button>
                          <button
                            className="icon-button small"
                            onClick={() => onCancel(item.id)}
                            title="Cancel"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="progress-track">
                        <span style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState icon={<ArrowDownToLine size={23} />} title="No active transfers">
                New transfers will appear here live.
              </EmptyState>
            )}
          </div>
          <div className="card storage-card">
            <div className="storage-icon"><HardDrive size={23} /></div>
            <div className="storage-copy">
              <span>PC storage</span>
              <strong>
                {snapshot.storage ? `${formatBytes(snapshot.storage.free, 0)} free` : "Checking…"}
              </strong>
              <div className="storage-track">
                <span style={{ width: `${storagePercent}%` }} />
              </div>
            </div>
            <button className="icon-button small" onClick={onOpenFolder} title="Open folder">
              <ExternalLink size={16} />
            </button>
          </div>
          <div className="stat-row">
            <div className="mini-stat">
              <div><CheckCircle2 size={18} /></div>
              <span>Files moved</span>
              <strong>{snapshot.history.filter((item) => item.status === "completed").length}</strong>
            </div>
            <div className="mini-stat">
              <div><MonitorDown size={18} /></div>
              <span>Total data</span>
              <strong>{formatBytes(totalMoved)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="quick-actions">
        <button onClick={onOpenFolder}>
          <div className="quick-icon purple"><FolderOpen size={20} /></div>
          <div><strong>Open received files</strong><span>Jump to your PocketDock folder</span></div>
          <ChevronRight size={18} />
        </button>
        <button onClick={onShareFiles}>
          <div className="quick-icon mint"><UploadCloud size={20} /></div>
          <div><strong>Send something back</strong><span>Share a PC file with your iPhone</span></div>
          <ChevronRight size={18} />
        </button>
      </section>

      <section className="card recent-card">
        <div className="card-heading compact">
          <div>
            <span className="eyebrow">Recent</span>
            <h3>Latest transfers</h3>
          </div>
          <button className="text-button" onClick={onShowAll}>
            View all <ArrowRight size={15} />
          </button>
        </div>
        <div className="transfer-list">
          {snapshot.history.length ? (
            snapshot.history.slice(0, 5).map((item) => (
              <TransferRow transfer={item} key={item.id} onReveal={onReveal} />
            ))
          ) : (
            <EmptyState icon={<Clock3 size={22} />} title="No transfers yet">
              Scan the code above to move your first file.
            </EmptyState>
          )}
        </div>
      </section>
    </>
  );
}

function TransfersPage({
  history,
  allHistory,
  search,
  filter,
  onSearch,
  onFilter,
  onReveal,
  onUpdate,
  onUpdateBulk,
  onAddTag,
  onShareSelected,
  onVaultSelected,
  onClear
}: {
  history: TransferRecord[];
  allHistory: TransferRecord[];
  search: string;
  filter: HistoryFilter;
  onSearch: (value: string) => void;
  onFilter: (value: HistoryFilter) => void;
  onReveal: (id: string) => void;
  onUpdate: (id: string, patch: TransferMetadataPatch) => Promise<void>;
  onUpdateBulk: (ids: string[], patch: TransferMetadataPatch) => Promise<void>;
  onAddTag: (ids: string[], tag: string) => Promise<void>;
  onShareSelected: (ids: string[], expiresMinutes: number) => Promise<boolean>;
  onVaultSelected: (ids: string[]) => Promise<boolean>;
  onClear: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<TransferRecord | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkTag, setBulkTag] = useState("");
  const [shareExpiry, setShareExpiry] = useState(1_440);
  const [transferAction, setTransferAction] = useState<string | null>(null);
  const transferActionInFlight = useRef(false);
  const now = Date.now();
  const recent = allHistory.filter(
    (item) => new Date(item.createdAt).getTime() >= now - 7 * 24 * 60 * 60 * 1_000
  );
  const finished = allHistory.filter((item) => item.status !== "active");
  const successRate = finished.length
    ? Math.round(
        (finished.filter((item) => item.status === "completed").length / finished.length) * 100
      )
    : 100;
  const today = allHistory.filter(
    (item) => new Date(item.createdAt).toDateString() === new Date().toDateString()
  ).length;
  const selected = allHistory.filter((item) => selectedIds.has(item.id));
  const selectedAvailable = selected.filter((item) => item.savedPath);
  const allVisibleSelected =
    history.length > 0 && history.every((item) => selectedIds.has(item.id));

  useEffect(() => {
    const valid = new Set(allHistory.map((item) => item.id));
    setSelectedIds((current) => new Set([...current].filter((id) => valid.has(id))));
  }, [allHistory]);

  const selectedArray = [...selectedIds];
  const clearSelection = () => setSelectedIds(new Set());

  const runTransferAction = async (key: string, action: () => Promise<void>) => {
    if (transferActionInFlight.current) return;
    transferActionInFlight.current = true;
    setTransferAction(key);
    try {
      await action();
    } finally {
      transferActionInFlight.current = false;
      setTransferAction(null);
    }
  };

  return (
    <>
      <div className="library-insights" aria-label="Transfer library insights">
        <div className="card">
          <TrendingUp size={18} />
          <span><strong>{formatBytes(recent.reduce((sum, item) => sum + item.size, 0))}</strong><small>Moved in 7 days</small></span>
        </div>
        <div className="card">
          <Activity size={18} />
          <span><strong>{today}</strong><small>Transfers today</small></span>
        </div>
        <div className="card">
          <CheckCircle2 size={18} />
          <span><strong>{successRate}%</strong><small>Completion rate</small></span>
        </div>
        <div className="card">
          <Star size={18} />
          <span><strong>{allHistory.filter((item) => item.favorite).length}</strong><small>Starred items</small></span>
        </div>
      </div>
      <section className="card transfers-page">
        <div className="collection-tabs" aria-label="Smart transfer collections">
          {([
            ["all", "Everything"],
            ["favorite", "Starred"],
            ["recent", "Last 7 days"],
            ["large", "Large files"],
            ["music", "Music"],
            ["photos", "Photos"]
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => onFilter(value)}
            >
              {value === "favorite" ? <Star size={14} /> : value === "music" ? <Music2 size={14} /> : value === "photos" ? <FileImage size={14} /> : <Sparkles size={14} />}
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search files, devices, tags, or notes"
            aria-label="Search transfer history"
          />
          {search && (
            <button onClick={() => onSearch("")} aria-label="Clear search">
              <X size={16} />
            </button>
          )}
        </div>
        <select
          className="status-filter-select"
          value={["completed", "failed", "cancelled"].includes(filter) ? filter : "collections"}
          aria-label="Filter transfer status"
          onChange={(event) =>
            onFilter(
              event.target.value === "collections"
                ? "all"
                : event.target.value as TransferStatus
            )
          }
        >
          <option value="collections">Any status</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button
          className="secondary-button danger"
          onClick={() => {
            if (!window.confirm(
              `Clear all ${allHistory.length} transfer histor${allHistory.length === 1 ? "y entry" : "y entries"}? This removes PocketDock's records, but does not delete the files.`
            )) return;
            void runTransferAction("clear", onClear);
          }}
          disabled={!allHistory.length || Boolean(transferAction)}
        >
          {transferAction === "clear" ? <RefreshCw className="spin" size={16} /> : <Trash2 size={16} />} {transferAction === "clear" ? "Clearing…" : "Clear history"}
        </button>
        </div>
        {selected.length > 0 && (
          <div className="bulk-action-bar" aria-label="Selected transfer actions">
            <div className="bulk-count">
              <CheckCircle2 size={16} />
              <strong>{selected.length} selected</strong>
              <span>{selectedAvailable.length} available on disk</span>
            </div>
            <button
              className="secondary-button"
              disabled={Boolean(transferAction)}
              onClick={() => void runTransferAction(
                "bulk:favorite",
                () => onUpdateBulk(selectedArray, { favorite: true })
              )}
            >
              {transferAction === "bulk:favorite" ? <RefreshCw className="spin" size={15} /> : <Star size={15} />} Star
            </button>
            <div className="bulk-tag-control">
              <input
                value={bulkTag}
                disabled={Boolean(transferAction)}
                maxLength={32}
                placeholder="Add tag"
                aria-label="Tag selected transfers"
                onChange={(event) => setBulkTag(event.target.value)}
              />
              <button
                className="secondary-button"
                disabled={!bulkTag.trim() || Boolean(transferAction)}
                onClick={() => void runTransferAction("bulk:tag", async () => {
                  await onAddTag(selectedArray, bulkTag.trim());
                  setBulkTag("");
                })}
              >
                {transferAction === "bulk:tag" ? <RefreshCw className="spin" size={15} /> : <Tag size={15} />} Apply
              </button>
            </div>
            <select
              value={shareExpiry}
              disabled={Boolean(transferAction)}
              aria-label="Selected file availability"
              onChange={(event) => setShareExpiry(Number(event.target.value))}
            >
              <option value="0">Share indefinitely</option>
              <option value="60">Share for 1 hour</option>
              <option value="1440">Share for 1 day</option>
              <option value="10080">Share for 1 week</option>
              <option value="43200">Share for 30 days</option>
            </select>
            <button
              className="primary-button"
              disabled={!selectedAvailable.length || Boolean(transferAction)}
              onClick={() => void runTransferAction("bulk:share", async () => {
                if (await onShareSelected(selectedArray, shareExpiry)) clearSelection();
              })}
            >
              {transferAction === "bulk:share" ? <RefreshCw className="spin" size={15} /> : <Send size={15} />} Send to iPhone
            </button>
            <button
              className="secondary-button"
              disabled={!selectedAvailable.length || Boolean(transferAction)}
              onClick={() => void runTransferAction("bulk:vault", async () => {
                if (await onVaultSelected(selectedArray)) clearSelection();
              })}
            >
              {transferAction === "bulk:vault" ? <RefreshCw className="spin" size={15} /> : <LockKeyhole size={15} />} Add to Vault
            </button>
            <button className="icon-button small" disabled={Boolean(transferAction)} onClick={clearSelection} title="Clear selection">
              <X size={16} />
            </button>
          </div>
        )}
        <div className="transfer-table-heading">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={Boolean(transferAction)}
            aria-label="Select all visible transfers"
            onChange={(event) => {
              setSelectedIds((current) => {
                const next = new Set(current);
                for (const item of history) {
                  if (event.target.checked) next.add(item.id);
                  else next.delete(item.id);
                }
                return next;
              });
            }}
          />
          <span>File</span><span>Direction</span><span>When</span><span>Status</span><span>Actions</span>
        </div>
        <div className="transfer-list full">
          {history.length ? (
            history.map((item) => (
              <TransferRow
                transfer={item}
                key={item.id}
                onReveal={onReveal}
                onToggleFavorite={(transfer) =>
                  void runTransferAction(
                    `favorite:${transfer.id}`,
                    () => onUpdate(transfer.id, { favorite: !transfer.favorite })
                  )
                }
                onEdit={setEditing}
                actionsDisabled={Boolean(transferAction)}
                selected={selectedIds.has(item.id)}
                onSelect={(transfer, checked) => {
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (checked) next.add(transfer.id);
                    else next.delete(transfer.id);
                    return next;
                  });
                }}
                detailed
              />
            ))
          ) : (
            <EmptyState icon={<Search size={24} />} title="Nothing matches">
              Try another search or transfer a file from your iPhone.
            </EmptyState>
          )}
        </div>
      </section>
      {editing && (
        <TransferMetadataDialog
          transfer={editing}
          onClose={() => setEditing(null)}
          saving={Boolean(transferAction)}
          onSave={(patch) => runTransferAction(`metadata:${editing.id}`, async () => {
            await onUpdate(editing.id, patch);
            setEditing(null);
          })}
        />
      )}
    </>
  );
}

function SharePage({
  files,
  connected,
  onAdd,
  onRemove,
  onGoHome,
  onDrop
}: {
  files: SharedFile[];
  connected: number;
  onAdd: (expiresMinutes: number) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onGoHome: () => void;
  onDrop: (files: File[], expiresMinutes: number) => Promise<void>;
}) {
  const [dragging, setDragging] = useState(false);
  const [expiresMinutes, setExpiresMinutes] = useState(1_440);
  const [shareAction, setShareAction] = useState<string | null>(null);
  const shareActionInFlight = useRef(false);

  const runShareAction = async (key: string, action: () => Promise<void>) => {
    if (shareActionInFlight.current) return;
    shareActionInFlight.current = true;
    setShareAction(key);
    try {
      await action();
    } finally {
      shareActionInFlight.current = false;
      setShareAction(null);
    }
  };

  return (
    <div className="share-layout">
      <section
        className={`card share-drop-card ${dragging ? "dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const droppedFiles = Array.from(event.dataTransfer.files);
          if (droppedFiles.length) {
            void runShareAction("drop", () => onDrop(droppedFiles, expiresMinutes));
          }
        }}
      >
        <div className="share-illustration">
          <div className="share-device"><Laptop size={48} /></div>
          <div className="share-path"><span /><ArrowRight size={19} /><span /></div>
          <div className="share-device phone"><Smartphone size={44} /></div>
        </div>
        <span className="eyebrow">PC → iPhone</span>
        <h2>Put a file in your pocket.</h2>
        <p>
          Choose files on this PC. They’ll appear on the connected iPhone, ready to
          download or save into Files.
        </p>
        <div className="share-availability-control">
          <label htmlFor="share-availability">Available for</label>
          <select
            id="share-availability"
            value={expiresMinutes}
            disabled={Boolean(shareAction)}
            onChange={(event) => setExpiresMinutes(Number(event.target.value))}
          >
            <option value="60">1 hour</option>
            <option value="1440">1 day</option>
            <option value="10080">1 week</option>
            <option value="43200">30 days</option>
            <option value="0">Until removed</option>
          </select>
        </div>
        <button
          className="primary-button large"
          disabled={Boolean(shareAction)}
          onClick={() => void runShareAction("add", () => onAdd(expiresMinutes))}
        >
          {shareAction === "add" ? <RefreshCw className="spin" size={19} /> : <Plus size={19} />} {shareAction === "add" ? "Choosing…" : "Choose files"}
        </button>
        <span className="drop-hint">or drag files anywhere onto this card</span>
        <div className={`device-presence ${connected ? "online" : ""}`}>
          <span />
          {connected
            ? `${connected} ${connected === 1 ? "device" : "devices"} connected`
            : "Scan the Home QR code to connect"}
          {!connected && <button onClick={onGoHome}>Go Home</button>}
        </div>
      </section>
      <section className="card share-list-card">
        <div className="card-heading compact">
          <div>
            <span className="eyebrow">Available on iPhone</span>
            <h3>{files.length ? `${files.length} ready to download` : "Share list"}</h3>
          </div>
          {files.length > 0 && (
            <button
              className="secondary-button"
              disabled={Boolean(shareAction)}
              onClick={() => void runShareAction("add", () => onAdd(expiresMinutes))}
            >
              {shareAction === "add" ? <RefreshCw className="spin" size={16} /> : <Plus size={16} />} Add more
            </button>
          )}
        </div>
        <div className="shared-file-list">
          {files.length ? (
            files.map((file) => (
              <div className="shared-file" key={file.id}>
                <div className="file-type-icon">{fileIcon(file.name, 20)}</div>
                <div>
                  <strong>{file.name}</strong>
                  <span>
                    {formatBytes(file.size)} · added {formatDate(file.createdAt)}
                    {file.expiresAt ? ` · expires ${formatDate(file.expiresAt)}` : ""}
                  </span>
                </div>
                <div className="ready-label"><Check size={14} /> Ready</div>
                <button
                  className="icon-button small"
                  disabled={Boolean(shareAction)}
                  onClick={() => {
                    if (!window.confirm(
                      `Stop sharing “${file.name}”? It will disappear from the iPhone download list, but the original PC file will not be deleted.`
                    )) return;
                    void runShareAction(`remove:${file.id}`, () => onRemove(file.id));
                  }}
                  aria-label={`Stop sharing ${file.name}`}
                  title="Stop sharing"
                >
                  {shareAction === `remove:${file.id}`
                    ? <RefreshCw className="spin" size={17} />
                    : <X size={17} />}
                </button>
              </div>
            ))
          ) : (
            <EmptyState icon={<Download size={24} />} title="Nothing shared yet">
              Files you choose will be available only while PocketDock is running.
            </EmptyState>
          )}
        </div>
        <div className="share-security-note">
          <ShieldCheck size={17} />
          Only an iPhone paired with the current PocketDock code can access these files.
        </div>
      </section>
    </div>
  );
}

function ClipboardPage({
  entries,
  onCopy,
  onSend,
  onCapture,
  onClear
}: {
  entries: ClipboardEntry[];
  onCopy: (id: string) => void;
  onSend: (content: string) => Promise<void>;
  onCapture: () => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [clipboardAction, setClipboardAction] = useState<string | null>(null);
  const clipboardActionInFlight = useRef(false);

  const runClipboardAction = async (key: string, action: () => Promise<void>) => {
    if (clipboardActionInFlight.current) return;
    clipboardActionInFlight.current = true;
    setClipboardAction(key);
    try {
      await action();
    } finally {
      clipboardActionInFlight.current = false;
      setClipboardAction(null);
    }
  };

  return (
    <div className="clipboard-layout">
      <section className="card clipboard-compose">
        <div className="clipboard-hero-icon"><Clipboard size={28} /></div>
        <span className="eyebrow">PC ↔ iPhone</span>
        <h2>One clipboard, both devices.</h2>
        <p>Share lyrics, links, notes, prompts, addresses, and anything else you can copy.</p>
        <textarea
          value={content}
          disabled={Boolean(clipboardAction)}
          maxLength={250_000}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Type or paste something to share…"
        />
        <div className="clipboard-actions">
          <button
            className="primary-button"
            disabled={!content.trim() || Boolean(clipboardAction)}
            onClick={() => void runClipboardAction("send", async () => {
              await onSend(content);
              setContent("");
            })}
          >
            {clipboardAction === "send" ? <RefreshCw className="spin" size={17} /> : <UploadCloud size={17} />} {clipboardAction === "send" ? "Sharing…" : "Share text"}
          </button>
          <button
            className="secondary-button"
            disabled={Boolean(clipboardAction)}
            onClick={() => void runClipboardAction("capture", onCapture)}
          >
            {clipboardAction === "capture" ? <RefreshCw className="spin" size={16} /> : <Clipboard size={16} />} {clipboardAction === "capture" ? "Reading…" : "Use Windows clipboard"}
          </button>
        </div>
        <div className="share-security-note">
          <ShieldCheck size={17} /> Clipboard payloads use the same AES-256 encrypted channel as files.
        </div>
      </section>
      <section className="card clipboard-list-card">
        <div className="card-heading compact">
          <div>
            <span className="eyebrow">Recent clipboard</span>
            <h3>{entries.length ? `${entries.length} shared items` : "Nothing shared yet"}</h3>
          </div>
          <button
            className="secondary-button danger"
            onClick={() => {
              if (!window.confirm(`Clear all ${entries.length} shared clipboard item${entries.length === 1 ? "" : "s"}?`)) return;
              void runClipboardAction("clear", onClear);
            }}
            disabled={!entries.length || Boolean(clipboardAction)}
          >
            {clipboardAction === "clear" ? <RefreshCw className="spin" size={15} /> : <Trash2 size={15} />} {clipboardAction === "clear" ? "Clearing…" : "Clear"}
          </button>
        </div>
        <div className="desktop-clipboard-list">
          {entries.length ? entries.map((entry) => (
            <button className="desktop-clipboard-entry" key={entry.id} onClick={() => onCopy(entry.id)}>
              <div className="clipboard-kind">{entry.kind === "url" ? <ExternalLink size={18} /> : <FileText size={18} />}</div>
              <div>
                <strong>{entry.content.replace(/\s+/g, " ")}</strong>
                <span>{entry.sourceDevice} · {formatDate(entry.createdAt)}</span>
              </div>
              <Copy size={16} />
            </button>
          )) : (
            <EmptyState icon={<Clipboard size={23} />} title="The shared clipboard is empty">
              Send text from this PC or open the Clipboard tab on your iPhone.
            </EmptyState>
          )}
        </div>
      </section>
    </div>
  );
}

function UsbPage({
  devices,
  importEnabled,
  onRefresh,
  onImport,
  onOpenAppleDevices
}: {
  devices: UsbDevice[];
  importEnabled: boolean;
  onRefresh: () => Promise<ActionStatus>;
  onImport: (id: string) => Promise<ActionStatus>;
  onOpenAppleDevices: () => Promise<ActionStatus>;
}) {
  const readyCount = devices.filter((device) => device.dcimDetected).length;
  const recognizedCount = devices.filter((device) => device.driverDetected).length;
  const [usbAction, setUsbAction] = useState<string | null>(null);
  const [usbStatus, setUsbStatus] = useState<ActionStatus | null>(null);
  const usbActionInFlight = useRef(false);

  const runUsbAction = async (
    key: string,
    pendingMessage: string,
    action: () => Promise<ActionStatus>
  ) => {
    if (usbActionInFlight.current) return;
    usbActionInFlight.current = true;
    setUsbAction(key);
    setUsbStatus({ tone: "info", message: pendingMessage });
    try {
      setUsbStatus(await action());
    } catch (error) {
      setUsbStatus({
        tone: "error",
        message: messageFromError(error, "The USB action could not be completed.")
      });
    } finally {
      usbActionInFlight.current = false;
      setUsbAction(null);
    }
  };

  return (
    <div className="usb-layout">
      {usbStatus && (
        <div
          className={`inline-action-status ${usbStatus.tone}`}
          role={usbStatus.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          style={{ gridColumn: "1 / -1", margin: 0 }}
        >
          {usbAction
            ? <RefreshCw className="spin" size={16} />
            : usbStatus.tone === "error"
              ? <AlertTriangle size={16} />
              : <CheckCircle2 size={16} />}
          <span>{usbStatus.message}</span>
        </div>
      )}
      <section className="card usb-intro">
        <div className="usb-illustration">
          <div><Smartphone size={48} /></div>
          <span />
          <Usb size={28} />
          <span />
          <div><Laptop size={48} /></div>
        </div>
        <span className="eyebrow">USB Files & Camera Roll</span>
        <h2>Move files by cable, not just photos.</h2>
        <p>
          Camera Roll imports use Windows DCIM access. Any files or folders you select in the
          native PocketDock app are available through Apple Devices → Files → PocketDock.
        </p>
        <button
          className="secondary-button"
          disabled={Boolean(usbAction)}
          onClick={() => void runUsbAction(
            "scan",
            "Scanning Windows for Apple USB, storage, and DCIM access…",
            onRefresh
          )}
        >
          <RefreshCw className={usbAction === "scan" ? "spin" : ""} size={16} />
          {usbAction === "scan" ? "Scanning…" : "Run USB capability scan"}
        </button>
      </section>
      <section className="card usb-devices">
        <div className="card-heading compact">
          <div>
            <span className="eyebrow">Windows portable-device access</span>
            <h3>
              {readyCount
                ? "iPhone recognized · Camera Roll ready"
                : recognizedCount
                  ? "iPhone recognized · Camera Roll not ready"
                  : "No Apple device detected"}
            </h3>
          </div>
          <span
            className={`usb-count ${recognizedCount ? "online" : ""}`}
            title={`${recognizedCount} physically recognized iPhone connection${recognizedCount === 1 ? "" : "s"}; ${readyCount} Camera Roll ready`}
            aria-label={`${recognizedCount} physically recognized iPhone connection${recognizedCount === 1 ? "" : "s"}`}
          >
            {recognizedCount}
          </span>
        </div>
        <div className="usb-device-list">
          {devices.length ? devices.map((device) => (
            <div className="usb-device" key={device.id}>
              <div className="usb-device-icon"><Smartphone size={24} /></div>
              <div className="usb-device-detail">
                <strong>{device.name}</strong>
                <span>{device.description}</span>
                <div className="usb-capability-grid" aria-label={`${device.name} USB capability status`}>
                  <UsbCapability label="Driver" ready={device.driverDetected} />
                  <UsbCapability label="This PC" ready={device.shellDetected} />
                  <UsbCapability label="Storage" ready={device.storageDetected} />
                  <UsbCapability label="DCIM" ready={device.dcimDetected} />
                </div>
                <small className="usb-action">
                  {device.dcimDetected ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                  {device.recommendedAction}
                </small>
              </div>
              <button
                className="primary-button"
                disabled={Boolean(usbAction) || !importEnabled || !device.dcimDetected}
                title={
                  !importEnabled
                    ? "USB Camera Roll import is turned off in Settings."
                    : !device.dcimDetected
                      ? "Camera Roll access must be ready before importing."
                      : undefined
                }
                onClick={() => void runUsbAction(
                  `import:${device.id}`,
                  `Importing new Camera Roll items from ${device.name}. Keep the iPhone unlocked…`,
                  () => onImport(device.id)
                )}
              >
                {usbAction === `import:${device.id}`
                  ? <RefreshCw className="spin" size={16} />
                  : <Download size={16} />} {usbAction === `import:${device.id}` ? "Importing…" : importEnabled ? "Import new" : "Import off"}
              </button>
            </div>
          )) : (
            <EmptyState icon={<Usb size={25} />} title="Windows does not see an Apple USB driver">
              Use a data-capable cable, unlock the iPhone, tap Trust, and install or repair Apple Devices for Windows.
            </EmptyState>
          )}
        </div>
        <div className={`share-security-note ${!importEnabled ? "warning" : ""}`}>
          <Info size={17} />
          {importEnabled
            ? "Phone recognition and Camera Roll access are separate. A green DCIM stage is required before importing."
            : "The iPhone remains recognized, but USB Camera Roll import is turned off. Enable USB Camera Roll import in Settings to import."}
        </div>
      </section>
      <section className="card usb-document-bridge">
        <div className="usb-document-icon"><FileUp size={25} /></div>
        <div>
          <span className="eyebrow">All selected files & folders</span>
          <h3>Use Apple Devices to move PocketDock files over USB.</h3>
          <p>
            On your iPhone, open <strong>More → USB Documents</strong> and choose
            <strong> Add Files or Folders for USB</strong>. Then in Apple Devices, choose your
            iPhone, open <strong>Files</strong>, and choose <strong>PocketDock</strong>.
          </p>
        </div>
        <button
          className="secondary-button"
          disabled={Boolean(usbAction)}
          onClick={() => void runUsbAction(
            "apple-devices",
            "Opening Apple Devices…",
            onOpenAppleDevices
          )}
        >
          {usbAction === "apple-devices"
            ? <RefreshCw className="spin" size={16} />
            : <ExternalLink size={16} />} {usbAction === "apple-devices" ? "Opening…" : "Open Apple Devices"}
        </button>
      </section>
    </div>
  );
}

function UsbCapability({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={ready ? "ready" : "blocked"}>
      {ready ? <Check size={12} /> : <X size={12} />} {label}
    </span>
  );
}

function GalleryPage({
  history,
  playerSummary,
  onPreview,
  onReveal
}: {
  history: TransferRecord[];
  playerSummary: MediaPlayerSummary;
  onPreview: (trackId: string, queueTrackIds: readonly string[], posterUrl?: string) => void;
  onReveal: (id: string) => void;
}) {
  const media = useMemo(
    () =>
      history
        .filter((item) => item.status === "completed" && item.savedPath && item.size > 0)
        .slice(0, 80),
    [history]
  );
  const [previews, setPreviews] = useState<Record<string, MediaPreview | null>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [previewRetry, setPreviewRetry] = useState(0);
  const requestedPreviewIds = useRef(new Set<string>());
  const [kind, setKind] = useState<"all" | MediaPreview["kind"]>("all");

  useEffect(() => {
    let active = true;
    const pending = media.filter((item) => !requestedPreviewIds.current.has(item.id));
    for (const item of pending) requestedPreviewIds.current.add(item.id);
    void Promise.all(
      pending.map(async (item) => {
        try {
          return { id: item.id, preview: await api.getMediaPreview(item.id) };
        } catch (error) {
          return {
            id: item.id,
            preview: null,
            error: messageFromError(error, `Preview unavailable for ${item.fileName}.`)
          };
        }
      })
    ).then((results) => {
      if (!active) return;
      setPreviews((current) => ({
        ...current,
        ...Object.fromEntries(results.map((result) => [result.id, result.preview]))
      }));
      setPreviewErrors((current) => ({
        ...current,
        ...Object.fromEntries(
          results
            .filter((result): result is typeof result & { error: string } => Boolean(result.error))
            .map((result) => [result.id, result.error])
        )
      }));
    });
    return () => {
      active = false;
    };
  }, [media, previewRetry]);

  const visible = media.filter((item) => kind === "all" || previews[item.id]?.kind === kind);
  const previewQueues: Record<PlayableMediaKind, string[]> = {
    audio: [],
    video: [],
    gif: []
  };
  for (const item of visible) {
    const itemKind = previews[item.id]?.kind ?? detectMediaKind(item.fileName, item.mimeType);
    if (isPlayableMediaKind(itemKind)) previewQueues[itemKind].push(transferPlayerId(item.id));
  }
  return (
    <section className="gallery-page">
      <div className="gallery-toolbar card">
        <div>
          <span className="eyebrow">Local previews</span>
          <h2>{media.length} recent media files</h2>
        </div>
        <div className="filter-tabs">
          {(["all", "image", "video", "gif", "audio", "document"] as const).map((value) => (
            <button
              key={value}
              className={kind === value ? "active" : ""}
              onClick={() => setKind(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {Object.keys(previewErrors).length > 0 && (
        <div className="inline-action-status warning" role="status">
          <AlertTriangle size={16} />
          <span>
            {Object.keys(previewErrors).length} media preview{Object.keys(previewErrors).length === 1 ? "" : "s"} could not be generated. The files are still available.
          </span>
          <button
            className="text-button"
            onClick={() => {
              for (const id of Object.keys(previewErrors)) requestedPreviewIds.current.delete(id);
              setPreviewErrors({});
              setPreviewRetry((value) => value + 1);
            }}
          >
            <RotateCcw size={14} /> Retry previews
          </button>
        </div>
      )}
      {visible.length ? (
        <div className="media-grid">
          {visible.map((item) => {
            const preview = previews[item.id];
            const previewKind = preview?.kind ?? detectMediaKind(item.fileName, item.mimeType);
            const playableKind = isPlayableMediaKind(previewKind) ? previewKind : null;
            const playerTrackId = transferPlayerId(item.id);
            const isActivePreview = playerSummary.currentTrackId === playerTrackId;
            const isPreviewLoading = isActivePreview && playerSummary.status === "loading";
            const isPreviewPlaying = isActivePreview && playerSummary.isPlaying;
            const isPreviewError = isActivePreview && (
              playerSummary.status === "error" || playerSummary.status === "unavailable"
            );
            const previewActionLabel = isPreviewPlaying
              ? `Pause ${item.fileName}`
              : isPreviewLoading
                ? `Cancel loading ${item.fileName}`
                : isPreviewError
                  ? `Retry ${item.fileName}`
                  : `Play ${previewKind === "gif" ? "animated GIF" : `${previewKind} preview`} ${item.fileName}`;
            return (
              <article className={`media-card card ${isActivePreview ? "active-preview" : ""}`} key={item.id}>
                <button
                  className="media-preview"
                  onClick={() => {
                    if (playableKind) onPreview(playerTrackId, previewQueues[playableKind], preview?.dataUrl);
                    else onReveal(item.id);
                  }}
                  aria-label={playableKind ? previewActionLabel : `Show ${item.fileName} in its folder`}
                >
                  {preview?.dataUrl ? (
                    <img src={preview.dataUrl} alt="" />
                  ) : preview?.kind === "audio" && preview.waveform?.length ? (
                    <div className="waveform">
                      {preview.waveform.map((value, index) => (
                        <i key={index} style={{ height: `${Math.max(5, value * 100)}%` }} />
                      ))}
                    </div>
                  ) : (
                    <div className="media-placeholder">{fileIcon(item.fileName, 42)}</div>
                  )}
                  {playableKind && (
                    <span className={`media-play-overlay ${isActivePreview ? "active" : ""}`} aria-hidden="true">
                      {isPreviewLoading
                        ? <RefreshCw className="spin" size={23} />
                        : isPreviewPlaying
                          ? <Pause size={23} fill="currentColor" />
                          : isPreviewError
                            ? <AlertTriangle size={22} />
                            : <Play size={23} fill="currentColor" />}
                    </span>
                  )}
                </button>
                <div className="media-copy">
                  <strong title={item.fileName}>{item.fileName}</strong>
                  <span>{formatBytes(item.size)} · {formatDate(item.completedAt ?? item.createdAt)}</span>
                  {preview?.music && (
                    <em>
                      {[
                        preview.music.bpm && `${preview.music.bpm} BPM`,
                        preview.music.musicalKey,
                        preview.music.sampleRate && `${preview.music.sampleRate / 1000} kHz`,
                        preview.music.bitDepth && `${preview.music.bitDepth}-bit`
                      ].filter(Boolean).join(" · ") || "Audio file"}
                    </em>
                  )}
                  <div className="media-card-actions">
                    {playableKind && (
                      <button
                        type="button"
                        className={`text-button media-card-play ${isActivePreview ? "active" : ""}`}
                        aria-label={previewActionLabel}
                        aria-pressed={isPreviewPlaying}
                        onClick={() => onPreview(playerTrackId, previewQueues[playableKind], preview?.dataUrl)}
                      >
                        {isPreviewLoading
                          ? <RefreshCw className="spin" size={14} />
                          : isPreviewPlaying
                            ? <Pause size={14} fill="currentColor" />
                            : <Play size={14} fill="currentColor" />}
                        {isPreviewPlaying ? "Pause" : isPreviewError ? "Retry" : previewKind === "gif" ? "Animate" : "Play"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Show ${item.fileName} in its folder`}
                      onClick={() => onReveal(item.id)}
                    >
                      <FolderOpen size={14} /> Show in folder
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <section className="card">
          <EmptyState icon={<Images size={28} />} title="No matching media yet">
            Received photos, videos, audio, and documents will appear here.
          </EmptyState>
        </section>
      )}
    </section>
  );
}

function PrivateLinksPage({
  files,
  links,
  onCreate,
  onCopy,
  onQr,
  onSaveQr,
  onRevoke,
  onAddFiles
}: {
  files: SharedFile[];
  links: PrivateShareLink[];
  onCreate: (name: string, ids: string[], hours: number, maximum: number) => Promise<void>;
  onCopy: (id: string) => Promise<void>;
  onQr: (id: string) => Promise<string>;
  onSaveQr: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onAddFiles: () => Promise<void>;
}) {
  const [name, setName] = useState("Private PocketDock delivery");
  const [selected, setSelected] = useState<string[]>([]);
  const [hours, setHours] = useState(24);
  const [maximum, setMaximum] = useState(10);
  const [qrPreview, setQrPreview] = useState<{ id: string; name: string; dataUrl: string } | null>(null);
  const [qrLoadingId, setQrLoadingId] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [linkAction, setLinkAction] = useState<string | null>(null);
  const linkActionInFlight = useRef(false);

  const runLinkAction = async (key: string, action: () => Promise<void>) => {
    if (linkActionInFlight.current) return;
    linkActionInFlight.current = true;
    setLinkAction(key);
    try {
      await action();
    } finally {
      linkActionInFlight.current = false;
      setLinkAction(null);
    }
  };

  const showQr = async (link: PrivateShareLink) => {
    setQrLoadingId(link.id);
    setQrError(null);
    try {
      const dataUrl = await onQr(link.id);
      setQrPreview({ id: link.id, name: link.name, dataUrl });
    } catch (error) {
      setQrError(messageFromError(error, "The private-link QR code could not be generated."));
    } finally {
      setQrLoadingId(null);
    }
  };

  return (
    <div className="links-layout">
      <section className="card link-builder">
        <div className="settings-heading">
          <div className="settings-icon"><Link2 size={21} /></div>
          <div><h3>Create a private link</h3><p>The token and AES key stay inside the generated link.</p></div>
        </div>
        <label>
          Delivery name
          <input disabled={Boolean(linkAction)} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="link-limits">
          <label>
            Expires after
            <select disabled={Boolean(linkAction)} value={hours} onChange={(event) => setHours(Number(event.target.value))}>
              <option value="1">1 hour</option>
              <option value="24">1 day</option>
              <option value="168">1 week</option>
              <option value="720">30 days</option>
            </select>
          </label>
          <label>
            File download limit
            <input disabled={Boolean(linkAction)} type="number" min="1" max="10000" value={maximum} onChange={(event) => setMaximum(Number(event.target.value))} />
          </label>
        </div>
        <div className="link-file-picker">
          <div className="card-heading compact">
            <strong>Files in this link</strong>
            <button
              className="secondary-button"
              disabled={Boolean(linkAction)}
              onClick={() => void runLinkAction("add-files", onAddFiles)}
            >
              {linkAction === "add-files" ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />} Add files
            </button>
          </div>
          {files.map((file) => (
            <label className="link-file-option" key={file.id}>
              <input
                type="checkbox"
                disabled={Boolean(linkAction)}
                checked={selected.includes(file.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, file.id]
                      : current.filter((id) => id !== file.id)
                  )
                }
              />
              <span>{fileIcon(file.name, 17)}</span>
              <strong>{file.name}</strong>
              <em>{formatBytes(file.size)}</em>
            </label>
          ))}
          {!files.length && <p className="settings-empty">Add PC files before creating a link.</p>}
        </div>
        <button
          className="primary-button large"
          disabled={!name.trim() || !selected.length || Boolean(linkAction)}
          onClick={() => void runLinkAction("create", async () => {
            await onCreate(name, selected, hours, maximum);
            setSelected([]);
          })}
        >
          {linkAction === "create" ? <RefreshCw className="spin" size={18} /> : <ShieldCheck size={18} />} {linkAction === "create" ? "Creating…" : "Create encrypted link"}
        </button>
      </section>
      <section className="card links-list">
        <div className="card-heading compact">
          <div><span className="eyebrow">Controlled access</span><h3>Private links</h3></div>
        </div>
        {qrError && (
          <div className="inline-action-status error" role="alert">
            <AlertTriangle size={16} /><span>{qrError}</span>
          </div>
        )}
        {links.length ? links.map((link) => {
          const inactive = link.revoked || new Date(link.expiresAt).getTime() <= Date.now();
          return (
            <div className={`private-link-row ${inactive ? "inactive" : ""}`} key={link.id}>
              <div className="clipboard-kind"><Link2 size={18} /></div>
              <div>
                <strong>{link.name}</strong>
                <span>
                  {link.sharedFileIds.length} files · {link.downloads}/{link.maxDownloads} file downloads ·
                  expires {formatDate(link.expiresAt)}
                </span>
              </div>
              {!inactive && (
                <div className="private-link-actions">
                  <button
                    className="icon-button small"
                    disabled={Boolean(linkAction) || qrLoadingId === link.id}
                    onClick={() => void showQr(link)}
                    title="Show QR code"
                    aria-label={`Show QR code for ${link.name}`}
                  >
                    {qrLoadingId === link.id
                      ? <RefreshCw className="spin" size={16} />
                      : <QrCode size={16} />}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={Boolean(linkAction)}
                    onClick={() => void runLinkAction(`copy:${link.id}`, () => onCopy(link.id))}
                  >
                    {linkAction === `copy:${link.id}` ? <RefreshCw className="spin" size={15} /> : <Copy size={15} />} Copy
                  </button>
                </div>
              )}
              {!link.revoked && (
                <button
                  className="icon-button small"
                  disabled={Boolean(linkAction)}
                  onClick={() => {
                    if (!window.confirm(`Revoke “${link.name}”? Its download link will stop working immediately.`)) return;
                    void runLinkAction(`revoke:${link.id}`, () => onRevoke(link.id));
                  }}
                  title="Revoke"
                >
                  {linkAction === `revoke:${link.id}`
                    ? <RefreshCw className="spin" size={16} />
                    : <X size={16} />}
                </button>
              )}
            </div>
          );
        }) : (
          <EmptyState icon={<Link2 size={25} />} title="No private links">
            Create an encrypted delivery with an expiration and download limit.
          </EmptyState>
        )}
      </section>
      {qrPreview && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setQrPreview(null)}>
          <div
            className="private-qr-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`QR code for ${qrPreview.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setQrPreview(null)} aria-label="Close">
              <X size={17} />
            </button>
            <img className="private-qr-brand" src="./branding/pocketdock_primary_horizontal.png" alt="PocketDock" />
            <div className="private-qr-shell"><img src={qrPreview.dataUrl} alt="" /></div>
            <h3>{qrPreview.name}</h3>
            <p>Scan with iPhone Camera to open this controlled delivery.</p>
            <button
              className="primary-button"
              disabled={Boolean(linkAction)}
              onClick={() => void runLinkAction(
                `save-qr:${qrPreview.id}`,
                () => onSaveQr(qrPreview.id)
              )}
            >
              {linkAction === `save-qr:${qrPreview.id}`
                ? <RefreshCw className="spin" size={15} />
                : <Download size={15} />} Save QR as PNG
            </button>
            <div className="share-security-note"><ShieldCheck size={16} /> The token and encryption key are inside the QR code.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function SyncPage({
  settings,
  profiles,
  watchFolders,
  remote,
  onUpdateSettings,
  onAddProfile,
  onUpdateProfile,
  onRemoveProfile,
  onRunProfile,
  onAddWatchFolder,
  onUpdateWatchFolder,
  onRemoveWatchFolder,
  onScanWatchFolders
}: {
  settings: AppSettings;
  profiles: SyncProfile[];
  watchFolders: WatchFolder[];
  remote: AppSnapshot["remoteStatus"];
  onUpdateSettings: (patch: Partial<AppSettings>, message?: string) => Promise<void>;
  onAddProfile: () => Promise<void>;
  onUpdateProfile: (id: string, patch: Partial<SyncProfile>) => Promise<void>;
  onRemoveProfile: (id: string) => Promise<void>;
  onRunProfile: (id: string) => Promise<void>;
  onAddWatchFolder: () => Promise<void>;
  onUpdateWatchFolder: (id: string, patch: Partial<WatchFolder>) => Promise<void>;
  onRemoveWatchFolder: (id: string) => Promise<void>;
  onScanWatchFolders: () => Promise<void>;
}) {
  const [remoteQr, setRemoteQr] = useState<string | null>(null);
  const [remoteQrError, setRemoteQrError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionInFlight = useRef(false);

  const runBusy = async (key: string, action: () => Promise<void>) => {
    if (busyActionInFlight.current) return;
    busyActionInFlight.current = true;
    setBusyAction(key);
    try {
      await action();
    } finally {
      busyActionInFlight.current = false;
      setBusyAction(null);
    }
  };

  useEffect(() => {
    let active = true;
    setRemoteQrError(null);
    void api.getRemoteQrCode()
      .then((next) => {
        if (active) setRemoteQr(next);
      })
      .catch((error) => {
        if (!active) return;
        setRemoteQr(null);
        setRemoteQrError(messageFromError(error, "The remote-pairing QR code could not be generated."));
      });
    return () => {
      active = false;
    };
  }, [remote.configured, remote.connected, remote.pairingUrl]);
  return (
    <div className="sync-layout">
      <section className="card sync-profiles-card">
        <div className="card-heading compact">
          <div><span className="eyebrow">Two-way folders</span><h3>Sync profiles</h3></div>
          <button
            className="primary-button"
            disabled={Boolean(busyAction)}
            onClick={() => void runBusy("profile:add", onAddProfile)}
          >
            {busyAction === "profile:add" ? <RefreshCw className="spin" size={16} /> : <Plus size={16} />} Add folder
          </button>
        </div>
        {profiles.length ? profiles.map((profile) => (
          <div className="sync-profile" key={profile.id}>
            <div className="sync-profile-icon"><FolderSync size={21} /></div>
            <div>
              <strong>{profile.name}</strong>
              <span title={profile.localDirectory}>{profile.localDirectory}</span>
              <em>{profile.lastRunAt ? `Last scan ${formatDate(profile.lastRunAt)}` : "Not scanned yet"}</em>
            </div>
            <select
              value={profile.direction}
              disabled={Boolean(busyAction)}
              onChange={(event) => void runBusy(`profile:update:${profile.id}`, () =>
                onUpdateProfile(profile.id, {
                  direction: event.target.value as SyncProfile["direction"]
                })
              )}
            >
              <option value="two-way">Two-way</option>
              <option value="iphone-to-pc">iPhone → PC</option>
              <option value="pc-to-iphone">PC → iPhone</option>
            </select>
            <button
              className="secondary-button"
              disabled={Boolean(busyAction)}
              onClick={() => void runBusy(`profile:scan:${profile.id}`, () => onRunProfile(profile.id))}
            >
              {busyAction === `profile:scan:${profile.id}` ? <RefreshCw className="spin" size={15} /> : <ScanLine size={15} />} Scan
            </button>
            <button
              className="icon-button small"
              disabled={Boolean(busyAction)}
              onClick={() => {
                if (!window.confirm(`Remove the sync profile “${profile.name}”? Files already on either device will not be deleted.`)) return;
                void runBusy(`profile:remove:${profile.id}`, () => onRemoveProfile(profile.id));
              }}
              title="Remove"
            >
              <Trash2 size={15} />
            </button>
          </div>
        )) : (
          <EmptyState icon={<FolderSync size={26} />} title="No synchronized folders">
            Pair a Windows folder with a native iPhone Files folder.
          </EmptyState>
        )}
      </section>

      <section className="card watch-folders-card">
        <div className="card-heading compact">
          <div><span className="eyebrow">Automatic delivery</span><h3>Watch folders</h3></div>
          <div className="inline-setting-actions">
            <button
              className="secondary-button"
              disabled={Boolean(busyAction)}
              onClick={() => void runBusy("watch:scan", onScanWatchFolders)}
            >
              <RefreshCw className={busyAction === "watch:scan" ? "spin" : ""} size={15} /> Scan
            </button>
            <button
              className="primary-button"
              disabled={Boolean(busyAction)}
              onClick={() => void runBusy("watch:add", onAddWatchFolder)}
            >
              {busyAction === "watch:add" ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />} Add
            </button>
          </div>
        </div>
        {watchFolders.length ? watchFolders.map((folder) => (
          <div className="watch-folder" key={folder.id}>
            <FolderOpen size={20} />
            <div><strong>{folder.name}</strong><span>{folder.directory}</span></div>
            <select
              value={folder.mode}
              disabled={Boolean(busyAction)}
              onChange={(event) => void runBusy(`watch:update:${folder.id}`, () =>
                onUpdateWatchFolder(folder.id, {
                  mode: event.target.value as WatchFolder["mode"]
                })
              )}
            >
              <option value="share">Share automatically</option>
              <option value="producer">Producer deliveries</option>
            </select>
            <select
              value={folder.expiresMinutes}
              disabled={Boolean(busyAction)}
              aria-label={`Availability window for ${folder.name}`}
              title="How long automatically shared files stay available"
              onChange={(event) => void runBusy(`watch:update:${folder.id}`, () =>
                onUpdateWatchFolder(folder.id, {
                  expiresMinutes: Number(event.target.value)
                })
              )}
            >
              <option value="0">No expiry</option>
              <option value="60">1 hour</option>
              <option value="1440">1 day</option>
              <option value="10080">1 week</option>
              <option value="43200">30 days</option>
            </select>
            <Toggle
              label={`Watch ${folder.name}`}
              checked={folder.enabled}
              disabled={Boolean(busyAction)}
              onChange={(enabled) => void runBusy(
                `watch:update:${folder.id}`,
                () => onUpdateWatchFolder(folder.id, { enabled })
              )}
            />
            <button
              className="icon-button small"
              disabled={Boolean(busyAction)}
              onClick={() => {
                if (!window.confirm(`Stop watching “${folder.name}”? Existing files and shares will remain.`)) return;
                void runBusy(`watch:remove:${folder.id}`, () => onRemoveWatchFolder(folder.id));
              }}
              title={`Remove ${folder.name}`}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )) : <p className="settings-empty">Files added to a watch folder can appear on your iPhone automatically.</p>}
      </section>

      <section className="card remote-card">
        <div className="settings-heading">
          <div className="settings-icon mint"><Wifi size={21} /></div>
          <div><h3>End-to-end encrypted remote access</h3><p>Connect the signed native iPhone client through your opaque relay.</p></div>
        </div>
        <div className="setting-row">
          <div><label>Remote bridge</label><p>Browser mode stays local-only; remote mode requires the native app.</p></div>
          <Toggle
            label="Remote access"
            checked={settings.remoteAccessEnabled}
            disabled={Boolean(busyAction)}
            onChange={(value) => void runBusy(
              "remote:enabled",
              () => onUpdateSettings({ remoteAccessEnabled: value })
            )}
          />
        </div>
        <div className="setting-row stacked">
          <label>Relay WebSocket endpoint</label>
          <input
            defaultValue={settings.remoteRelayUrl}
            disabled={Boolean(busyAction)}
            placeholder="wss://relay.example.com/v2/relay"
            onBlur={(event) => void runBusy(
              "remote:url",
              () => onUpdateSettings({ remoteRelayUrl: event.target.value.trim() })
            )}
          />
        </div>
        <div className={`remote-state ${remote.connected ? "online" : ""}`}>
          <span />
          {remote.connected
            ? remote.waitingForPeer ? "Relay connected · waiting for iPhone" : "Remote iPhone connected"
            : remote.lastError ?? "Remote relay is off"}
        </div>
        {remote.configured && (
          <div className="remote-security-metrics">
            <span>
              <ShieldCheck size={14} />
              {remote.forwardSecrecyActive ? "Forward-secret AES tunnel" : "Waiting for secure session"}
            </span>
            <span>
              <Clock3 size={14} />
              {remote.lastPeerAt ? `Peer seen ${formatDate(remote.lastPeerAt)}` : "No remote peer yet"}
            </span>
            <span>
              <Zap size={14} />
              {remote.rejectedReplayCount ?? 0} replay attempts blocked
            </span>
          </div>
        )}
        {remoteQr && settings.remoteAccessEnabled && (
          <div className="remote-qr">
            <img src={remoteQr} alt="Native iPhone remote pairing QR code" />
            <p>Scan inside the native PocketDock iPhone app.</p>
          </div>
        )}
        {remoteQrError && settings.remoteAccessEnabled && (
          <div className="inline-action-status error" role="alert">
            <AlertTriangle size={16} /><span>{remoteQrError}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function StudioPage({
  packages,
  onCreate
}: {
  packages: ProducerPackage[];
  onCreate: (details: {
    title: string;
    artist: string;
    bpm?: number;
    musicalKey?: string;
    notes: string;
    clientName?: string;
    licenseName?: string;
  }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("DocDamage");
  const [bpm, setBpm] = useState("");
  const [musicalKey, setMusicalKey] = useState("");
  const [notes, setNotes] = useState(
    "Includes tagged master, untagged master, instrumental, artwork, BPM, and key."
  );
  const [clientName, setClientName] = useState("");
  const [licenseName, setLicenseName] = useState("Standard non-exclusive license");
  const [preset, setPreset] = useState("beat-sale");
  const [studioAction, setStudioAction] = useState<string | null>(null);
  const studioActionInFlight = useRef(false);
  const presets = [
    {
      id: "beat-sale",
      label: "Beat Sale",
      detail: "Master + instrumental",
      note: "Includes tagged master, untagged master, instrumental, artwork, BPM, and key."
    },
    {
      id: "stems",
      label: "Stems Session",
      detail: "Tracked-out delivery",
      note: "Tracked-out stems aligned from bar one, reference mix, BPM, key, and session notes."
    },
    {
      id: "mix-review",
      label: "Mix Review",
      detail: "Client approval",
      note: "Mix review version. Please send timestamped revision notes and confirm playback format."
    },
    {
      id: "sync",
      label: "Sync Pitch",
      detail: "Clean, instrumental, alt",
      note: "Includes full, clean, instrumental, and alternate versions with complete metadata."
    }
  ];

  const createPackage = async () => {
    if (studioActionInFlight.current) return;
    studioActionInFlight.current = true;
    setStudioAction("create");
    try {
      const created = await onCreate({
        title,
        artist,
        bpm: bpm ? Number(bpm) : undefined,
        musicalKey,
        notes,
        clientName,
        licenseName
      });
      if (!created) return;
      setTitle("");
      setBpm("");
      setMusicalKey("");
      setClientName("");
    } finally {
      studioActionInFlight.current = false;
      setStudioAction(null);
    }
  };

  return (
    <div className="studio-layout">
      <section className="card studio-builder">
        <div className="studio-hero">
          <div><Music2 size={30} /></div>
          <span className="eyebrow">Producer delivery</span>
          <h2>Package the beat properly.</h2>
          <p>Bundle the master, instrumental, stems, MIDI, artwork, notes, and project files with a verified manifest.</p>
        </div>
        <div className="producer-presets">
          <div className="preset-heading"><Zap size={15} /><span>Delivery presets</span></div>
          <div>
            {presets.map((item) => (
              <button
                key={item.id}
                className={preset === item.id ? "active" : ""}
                disabled={Boolean(studioAction)}
                onClick={() => {
                  setPreset(item.id);
                  setNotes(item.note);
                }}
              >
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="studio-form">
          <label>Delivery title<input disabled={Boolean(studioAction)} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Midnight Pressure" /></label>
          <label>Producer / artist<input disabled={Boolean(studioAction)} value={artist} onChange={(event) => setArtist(event.target.value)} /></label>
          <div>
            <label>Client<input disabled={Boolean(studioAction)} value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Client or project" /></label>
            <label>License<input disabled={Boolean(studioAction)} value={licenseName} onChange={(event) => setLicenseName(event.target.value)} placeholder="License / usage terms" /></label>
          </div>
          <div>
            <label>BPM<input disabled={Boolean(studioAction)} type="number" min="20" max="400" value={bpm} onChange={(event) => setBpm(event.target.value)} placeholder="92" /></label>
            <label>Key<input disabled={Boolean(studioAction)} value={musicalKey} onChange={(event) => setMusicalKey(event.target.value)} placeholder="F# minor" /></label>
          </div>
          <label>Delivery notes<textarea disabled={Boolean(studioAction)} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Version, contact, usage, or mix notes…" /></label>
          <button
            className="primary-button large"
            disabled={!title.trim() || Boolean(studioAction)}
            onClick={() => void createPackage()}
          >
            {studioAction === "create" ? <RefreshCw className="spin" size={18} /> : <PackageOpen size={18} />} {studioAction === "create" ? "Building delivery…" : "Choose files and build delivery"}
          </button>
        </div>
          <div className="producer-quality-strip">
            <ShieldCheck size={17} />
            <div>
              <strong>Client-ready by default</strong>
              <span>Embedded art first · typo-tolerant catalog matching · SHA-256 manifest · delivery metadata</span>
            </div>
          </div>
      </section>
      <section className="card producer-packages">
        <div className="card-heading compact"><div><span className="eyebrow">Ready for iPhone</span><h3>Producer packages</h3></div></div>
        {packages.length ? packages.map((item) => (
          <div className="producer-package" key={item.id}>
            <div className="file-type-icon"><FileArchive size={20} /></div>
            <div><strong>{item.title} · v{item.version ?? 1}</strong><span>{item.clientName || item.artist || "Unassigned client"} · {item.fileCount} files · {formatBytes(item.size)}</span></div>
            <em>{item.approvalStatus ?? "draft"} · {item.downloadCount ?? 0} downloads</em>
            <span>{[item.bpm && `${item.bpm} BPM`, item.musicalKey].filter(Boolean).join(" · ") || formatDate(item.createdAt)}</span>
            {item.artwork && (
              <span className={`artwork-match ${item.artwork.status}`}>
                {item.artwork.status === "not-found"
                  ? "No confident artwork match"
                  : `${item.artwork.source} · ${Math.round(item.artwork.confidence * 100)}%`}
                {item.artwork.matchedTitle && ` · ${item.artwork.matchedTitle}`}
              </span>
            )}
          </div>
        )) : (
          <EmptyState icon={<Music2 size={27} />} title="No deliveries built yet">
            Your finished beat packages will be saved and shared here.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function VaultPage({
  items,
  initialized,
  unlocked,
  onInitialize,
  onUnlock,
  onLock,
  onAdd,
  onExport,
  onRemove
}: {
  items: VaultItem[];
  initialized: boolean;
  unlocked: boolean;
  onInitialize: (passphrase: string) => Promise<void>;
  onUnlock: (passphrase: string) => Promise<void>;
  onLock: () => Promise<void>;
  onAdd: () => Promise<void>;
  onExport: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [vaultAction, setVaultAction] = useState<string | null>(null);
  const vaultActionInFlight = useRef(false);

  const submitPassphrase = async () => {
    if (vaultActionInFlight.current) return;
    vaultActionInFlight.current = true;
    setVaultAction("passphrase");
    setPassphraseError(null);
    try {
      if (initialized) await onUnlock(passphrase);
      else await onInitialize(passphrase);
      setPassphrase("");
    } catch (error) {
      setPassphraseError(messageFromError(
        error,
        initialized ? "The vault could not be unlocked." : "The vault could not be initialized."
      ));
    } finally {
      vaultActionInFlight.current = false;
      setVaultAction(null);
    }
  };

  const runVaultAction = async (key: string, action: () => Promise<void>) => {
    if (vaultActionInFlight.current) return;
    vaultActionInFlight.current = true;
    setVaultAction(key);
    try {
      await action();
    } finally {
      vaultActionInFlight.current = false;
      setVaultAction(null);
    }
  };

  return (
    <div className="vault-layout">
      <section className="card vault-gate">
        <div className={`vault-lock ${unlocked ? "open" : ""}`}><LockKeyhole size={34} /></div>
        <span className="eyebrow">AES-256-GCM at rest</span>
        <h2>{unlocked ? "Vault unlocked" : initialized ? "Unlock your vault" : "Create your private vault"}</h2>
        <p>
          The passphrase never leaves this PC and is never stored. Losing it means losing access
          to the encrypted files.
        </p>
        {!unlocked ? (
          <>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => {
                setPassphrase(event.target.value);
                setPassphraseError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && passphrase.length >= 10 && !vaultAction) {
                  event.preventDefault();
                  void submitPassphrase();
                }
              }}
              autoComplete={initialized ? "current-password" : "new-password"}
              placeholder={initialized ? "Vault passphrase" : "New passphrase · 10+ characters"}
            />
            {passphraseError && (
              <div className="inline-action-status error vault-error" role="alert">
                <AlertTriangle size={16} /><span>{passphraseError}</span>
              </div>
            )}
            <button
              className="primary-button large"
              disabled={passphrase.length < 10 || Boolean(vaultAction)}
              onClick={() => void submitPassphrase()}
            >
              {vaultAction === "passphrase"
                ? <RefreshCw className="spin" size={17} />
                : <LockKeyhole size={17} />} {vaultAction === "passphrase" ? "Working…" : initialized ? "Unlock" : "Initialize vault"}
            </button>
          </>
        ) : (
          <div className="vault-actions">
            <button
              className="primary-button"
              disabled={Boolean(vaultAction)}
              onClick={() => void runVaultAction("add", onAdd)}
            >
              {vaultAction === "add" ? <RefreshCw className="spin" size={16} /> : <Plus size={16} />} Encrypt files
            </button>
            <button
              className="secondary-button"
              disabled={Boolean(vaultAction)}
              onClick={() => void runVaultAction("lock", onLock)}
            >
              Lock now
            </button>
          </div>
        )}
      </section>
      <section className="card vault-items">
        <div className="card-heading compact">
          <div><span className="eyebrow">Encrypted locally</span><h3>{items.length} vault items</h3></div>
        </div>
        {items.length ? items.map((item) => (
          <div className="vault-item" key={item.id}>
            <div className="file-type-icon">{fileIcon(item.name, 19)}</div>
            <div><strong>{item.name}</strong><span>{formatBytes(item.size)} · added {formatDate(item.createdAt)}</span></div>
            <span className="verified-label"><ShieldCheck size={14} /> SHA-256</span>
            <button
              className="secondary-button"
              disabled={!unlocked || Boolean(vaultAction)}
              onClick={() => void runVaultAction(`export:${item.id}`, () => onExport(item.id))}
            >
              {vaultAction === `export:${item.id}` ? <RefreshCw className="spin" size={15} /> : <Download size={15} />} Export
            </button>
            <button
              className="icon-button small"
              disabled={!unlocked || Boolean(vaultAction)}
              onClick={() => {
                if (!window.confirm(`Permanently remove “${item.name}” from the encrypted vault? This cannot be undone.`)) return;
                void runVaultAction(`remove:${item.id}`, () => onRemove(item.id));
              }}
              title="Permanently remove"
            >
              <Trash2 size={15} />
            </button>
          </div>
        )) : (
          <EmptyState icon={<LockKeyhole size={26} />} title="The vault is empty">
            Unlock it, then choose files to encrypt at rest.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function DrivePage({
  settings,
  transport,
  onUpdateSettings,
  onChooseRoot,
  onChanged
}: {
  settings: AppSettings;
  transport: AppSnapshot["transportStatus"];
  onUpdateSettings: (patch: Partial<AppSettings>, message?: string) => Promise<void>;
  onChooseRoot: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [relativePath, setRelativePath] = useState("");
  const [entries, setEntries] = useState<DriveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [driveAction, setDriveAction] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const driveActionInFlight = useRef(false);
  const load = useCallback(async () => {
    const requestId = ++loadRequest.current;
    setLoading(true);
    setLoadError(null);
    try {
      const nextEntries = await api.browseDrive(relativePath);
      if (requestId === loadRequest.current) setEntries(nextEntries);
    } catch (error) {
      if (requestId === loadRequest.current) {
        setEntries([]);
        setLoadError(messageFromError(error, "This approved Drive folder could not be opened."));
      }
    } finally {
      if (requestId === loadRequest.current) setLoading(false);
    }
  }, [relativePath, settings.remoteBrowseRoot]);

  useEffect(() => {
    void load();
  }, [load, settings.remoteBrowseRoot]);

  const commitRename = async (entry: DriveEntry) => {
    const next = renameName.trim();
    if (!next || next === entry.name) {
      setRenamingId(null);
      setRenameName("");
      return;
    }
    await api.renameDriveEntry(entry.relativePath, next);
    setRenamingId(null);
    setRenameName("");
    await load();
    await onChanged();
  };

  const runDriveAction = async (key: string, action: () => Promise<void>) => {
    if (driveActionInFlight.current) return;
    driveActionInFlight.current = true;
    setDriveAction(key);
    try {
      await action();
    } finally {
      driveActionInFlight.current = false;
      setDriveAction(null);
    }
  };

  const crumbs = relativePath ? relativePath.split("/") : [];
  return (
    <div className="drive-layout">
      <section className="card drive-control-card">
        <div className="drive-brand-orb"><FolderOpen size={30} /></div>
        <span className="eyebrow">Native Files integration</span>
        <h2>Your PC, inside the iPhone Files app.</h2>
        <p>
          Only this approved root is exposed. Every trusted iPhone still needs Browse and
          File Provider permission.
        </p>
        <div className="drive-root">
          <small>Approved root</small>
          <strong title={settings.remoteBrowseRoot}>{settings.remoteBrowseRoot}</strong>
          <button
            className="secondary-button"
            disabled={Boolean(driveAction)}
            onClick={() => void runDriveAction("root", onChooseRoot)}
          >
            {driveAction === "root" ? <RefreshCw className="spin" size={15} /> : null} Change root
          </button>
        </div>
        <div className="drive-toggles">
          <div>
            <span><strong>Enable PocketDock Drive</strong><small>Allow approved remote browsing.</small></span>
            <Toggle
              label="Enable PocketDock Drive"
              checked={settings.remoteBrowseEnabled}
              disabled={Boolean(driveAction)}
              onChange={(value) => void runDriveAction("settings:enabled", () =>
                onUpdateSettings(
                  { remoteBrowseEnabled: value },
                  value ? "PocketDock Drive enabled." : "PocketDock Drive disabled."
                )
              )}
            />
          </div>
          <div>
            <span><strong>Block Drive changes over relay</strong><small>Remote sessions stay read-only; local File Provider access still works.</small></span>
            <Toggle
              label="Block Drive changes over relay"
              checked={settings.remoteApprovalRequired}
              disabled={Boolean(driveAction)}
              onChange={(value) => void runDriveAction(
                "settings:approval",
                () => onUpdateSettings({ remoteApprovalRequired: value })
              )}
            />
          </div>
        </div>
        <div className={`transport-banner ${transport.selected}`}>
          <Zap size={16} />
          <div><strong>{transport.selected === "offline" ? "No active transport" : `${transport.selected.toUpperCase()} selected`}</strong><span>{transport.reason}</span></div>
        </div>
      </section>

      <section className="card drive-browser">
        <div className="drive-browser-head">
          <div>
            <span className="eyebrow">Approved file browser</span>
            <div className="drive-breadcrumbs">
              <button disabled={Boolean(driveAction)} onClick={() => setRelativePath("")}>Drive</button>
              {crumbs.map((crumb, index) => (
                <button
                  key={`${crumb}-${index}`}
                  disabled={Boolean(driveAction)}
                  onClick={() => setRelativePath(crumbs.slice(0, index + 1).join("/"))}
                >
                  <ChevronRight size={12} /> {crumb}
                </button>
              ))}
            </div>
          </div>
          <button className="icon-button" disabled={loading || Boolean(driveAction)} onClick={() => void load()} aria-label="Refresh Drive">
            <RefreshCw className={loading ? "spin" : ""} size={17} />
          </button>
        </div>
        {loadError && (
          <div className="inline-action-status error" role="alert">
            <AlertTriangle size={16} /><span>{loadError}</span>
            <button className="text-button" disabled={Boolean(driveAction)} onClick={() => void load()}>
              <RotateCcw size={14} /> Retry
            </button>
          </div>
        )}
        <div className="drive-create-folder">
          <input
            value={folderName}
            disabled={Boolean(driveAction)}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="New folder name"
          />
          <button
            className="secondary-button"
            disabled={!folderName.trim() || loading || Boolean(driveAction)}
            onClick={() => void runDriveAction("create", async () => {
              await api.createDriveFolder([relativePath, folderName.trim()].filter(Boolean).join("/"));
              setFolderName("");
              await load();
              await onChanged();
            })}
          >
            {driveAction === "create" ? <RefreshCw className="spin" size={15} /> : <FolderPlus size={15} />} Create
          </button>
        </div>
        <div className="drive-entry-list">
          {loading ? (
            <div className="health-loading"><div className="loader" /> Loading approved folder…</div>
          ) : loadError ? (
            <EmptyState icon={<AlertTriangle size={25} />} title="Drive folder unavailable">
              Use Retry above, or choose a different approved root.
            </EmptyState>
          ) : entries.length ? entries.map((entry) => {
            const isRenaming = renamingId === entry.id;
            return (
            <article className="drive-entry" key={entry.id}>
              <div className={`drive-entry-icon ${entry.kind}`}>
                {entry.kind === "folder" ? <FolderOpen size={20} /> : fileIcon(entry.name, 20)}
              </div>
              {isRenaming ? (
                <input
                  className="drive-rename-input"
                  value={renameName}
                  disabled={Boolean(driveAction)}
                  aria-label={`Rename ${entry.name}`}
                  autoFocus
                  onChange={(event) => setRenameName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setRenamingId(null);
                      setRenameName("");
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      void runDriveAction(`rename:${entry.id}`, () => commitRename(entry));
                    }
                  }}
                />
              ) : (
                <button
                  className="drive-entry-name"
                  disabled={Boolean(driveAction)}
                  title={entry.kind === "folder" ? `Open ${entry.name}` : `Show ${entry.name} in Explorer`}
                  onClick={() => {
                    if (entry.kind === "folder") {
                      setRelativePath(entry.relativePath);
                    } else {
                      void runDriveAction(
                        `reveal:${entry.id}`,
                        () => api.revealDriveEntry(entry.relativePath)
                      );
                    }
                  }}
                >
                  <strong>{entry.name}</strong>
                  <span>{entry.kind === "folder" ? "Folder" : formatBytes(entry.size)} · {formatDate(entry.modifiedAt)}</span>
                </button>
              )}
              <button
                className="secondary-button"
                disabled={Boolean(driveAction)}
                onClick={() => void runDriveAction(`rename:${entry.id}`, async () => {
                  if (isRenaming) {
                    await commitRename(entry);
                  } else {
                    setRenamingId(entry.id);
                    setRenameName(entry.name);
                  }
                })}
              >
                {driveAction === `rename:${entry.id}` ? "Saving…" : isRenaming ? "Save" : "Rename"}
              </button>
              <button
                className="icon-button small"
                disabled={Boolean(driveAction)}
                title={isRenaming ? "Cancel rename" : "Move to PocketDock Archive"}
                aria-label={isRenaming ? "Cancel rename" : `Archive ${entry.name}`}
                onClick={() => void runDriveAction(`archive:${entry.id}`, async () => {
                  if (isRenaming) {
                    setRenamingId(null);
                    setRenameName("");
                    return;
                  }
                  if (!window.confirm(`Move “${entry.name}” to the recoverable PocketDock Archive?`)) return;
                  await api.archiveDriveEntry(entry.relativePath);
                  await load();
                })}
              >
                {isRenaming ? <X size={15} /> : <ArchiveRestore size={15} />}
              </button>
            </article>
          );}) : (
            <EmptyState icon={<FolderOpen size={25} />} title="This folder is empty">
              Create a folder here or add files from Windows.
            </EmptyState>
          )}
        </div>
      </section>
    </div>
  );
}

function FileRequestsPage({
  requests,
  uploads,
  onCreate,
  onCopy,
  onQr,
  onSaveQr,
  onRevoke,
  onApprove,
  onReject
}: {
  requests: FileRequest[];
  uploads: FileRequestUpload[];
  onCreate: (details: {
    name: string;
    destinationSubfolder: string;
    expiresHours: number;
    maxFileSize: number;
    maxFiles: number;
    requiresApproval: boolean;
  }) => Promise<void>;
  onCopy: (id: string) => Promise<void>;
  onQr: (id: string) => Promise<string>;
  onSaveQr: (id: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState("Send files to Doc");
  const [folder, setFolder] = useState("File Requests");
  const [expires, setExpires] = useState(72);
  const [maxFiles, setMaxFiles] = useState(25);
  const [maxSizeMb, setMaxSizeMb] = useState(500);
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [qr, setQr] = useState<{ id: string; dataUrl: string } | null>(null);
  const [qrLoadingId, setQrLoadingId] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [uploadActionId, setUploadActionId] = useState<string | null>(null);
  const [requestAction, setRequestAction] = useState<string | null>(null);
  const requestActionInFlight = useRef(false);
  const pending = uploads.filter((item) => item.status === "pending");
  const requestBusy = Boolean(uploadActionId || requestAction);

  const showQr = async (request: FileRequest) => {
    setQrLoadingId(request.id);
    setQrError(null);
    try {
      setQr({ id: request.id, dataUrl: await onQr(request.id) });
    } catch (error) {
      setQrError(messageFromError(error, "The file-request QR code could not be generated."));
    } finally {
      setQrLoadingId(null);
    }
  };

  const runUploadAction = async (id: string, action: () => Promise<void>) => {
    if (requestActionInFlight.current) return;
    requestActionInFlight.current = true;
    setUploadActionId(id);
    try {
      await action();
    } finally {
      requestActionInFlight.current = false;
      setUploadActionId(null);
    }
  };

  const runRequestAction = async (key: string, action: () => Promise<void>) => {
    if (requestActionInFlight.current) return;
    requestActionInFlight.current = true;
    setRequestAction(key);
    try {
      await action();
    } finally {
      requestActionInFlight.current = false;
      setRequestAction(null);
    }
  };

  return (
    <div className="request-layout">
      <section className="card request-builder">
        <div className="request-hero">
          <div><FileUp size={28} /></div>
          <span className="eyebrow">Private upload inbox</span>
          <h2>Ask for files without asking for an account.</h2>
          <p>Create a bounded link or QR code that delivers directly to this PC.</p>
        </div>
        <div className="request-form">
          <label>Request title<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Destination subfolder<input value={folder} onChange={(event) => setFolder(event.target.value)} /></label>
          <div>
            <label>Expires
              <select value={expires} onChange={(event) => setExpires(Number(event.target.value))}>
                <option value={24}>1 day</option><option value={72}>3 days</option>
                <option value={168}>1 week</option><option value={720}>30 days</option>
              </select>
            </label>
            <label>Maximum files<input type="number" min="1" max="1000" value={maxFiles} onChange={(event) => setMaxFiles(Number(event.target.value))} /></label>
            <label>Per-file limit (MB)<input type="number" min="1" max="2048" value={maxSizeMb} onChange={(event) => setMaxSizeMb(Number(event.target.value))} /></label>
          </div>
          <label className="request-approval">
            <span><strong>Hold for approval</strong><small>Files stay in a private inbox until accepted.</small></span>
            <Toggle label="Hold requested files for approval" checked={requiresApproval} onChange={setRequiresApproval} />
          </label>
          <button
            className="primary-button large"
            disabled={!name.trim() || requestBusy}
            onClick={() => void runRequestAction("create", () => onCreate({
              name: name.trim(),
              destinationSubfolder: folder.trim(),
              expiresHours: expires,
              maxFiles,
              maxFileSize: maxSizeMb * 1024 * 1024,
              requiresApproval
            }))}
          >
            {requestAction === "create" ? <RefreshCw className="spin" size={17} /> : <Link2 size={17} />} {requestAction === "create" ? "Creating…" : "Create private request"}
          </button>
        </div>
      </section>

      <div className="request-side-stack">
        <section className="card request-inbox">
          <div className="card-heading compact">
            <div><span className="eyebrow">Approval inbox</span><h3>{pending.length} waiting</h3></div>
          </div>
          {pending.length ? pending.map((upload) => (
            <article className="request-upload" key={upload.id}>
              <div className="file-type-icon">{fileIcon(upload.fileName)}</div>
              <div><strong>{upload.fileName}</strong><span>{formatBytes(upload.size)} · SHA-256 checked</span></div>
              <button
                className="secondary-button"
                disabled={requestBusy}
                onClick={() => void runUploadAction(upload.id, () => onApprove(upload.id))}
              >
                {uploadActionId === upload.id ? <RefreshCw className="spin" size={14} /> : <Check size={14} />} Accept
              </button>
              <button
                className="icon-button small"
                disabled={requestBusy}
                onClick={() => {
                  if (!window.confirm(`Reject “${upload.fileName}”? The staged upload will be permanently removed.`)) return;
                  void runUploadAction(upload.id, () => onReject(upload.id));
                }}
                title="Reject upload"
              >
                <X size={15} />
              </button>
            </article>
          )) : (
            <EmptyState icon={<Inbox size={24} />} title="Approval inbox clear">
              New requested files will appear here.
            </EmptyState>
          )}
        </section>
        <section className="card active-requests">
          <div className="card-heading compact">
            <div><span className="eyebrow">Active links</span><h3>{requests.filter((item) => item.url).length} requests</h3></div>
          </div>
          {qrError && (
            <div className="inline-action-status error" role="alert">
              <AlertTriangle size={16} /><span>{qrError}</span>
            </div>
          )}
          {requests.length ? requests.map((request) => (
            <article className={`file-request-row ${request.url ? "" : "inactive"}`} key={request.id}>
              <div><strong>{request.name}</strong><span>{request.receivedCount}/{request.maxFiles} files · expires {formatDate(request.expiresAt)}</span></div>
              {request.url && (
                <button
                  className="icon-button small"
                  disabled={requestBusy}
                  onClick={() => void runRequestAction(`copy:${request.id}`, () => onCopy(request.id))}
                  title="Copy link"
                >
                  {requestAction === `copy:${request.id}`
                    ? <RefreshCw className="spin" size={15} />
                    : <Copy size={15} />}
                </button>
              )}
              {request.url && (
                <button
                  className="icon-button small"
                  disabled={requestBusy || qrLoadingId === request.id}
                  onClick={() => void showQr(request)}
                  title="Show QR"
                >
                  {qrLoadingId === request.id
                    ? <RefreshCw className="spin" size={15} />
                    : <QrCode size={15} />}
                </button>
              )}
              {request.url && (
                <button
                  className="icon-button small"
                  disabled={requestBusy}
                  onClick={() => {
                    if (!window.confirm(`Revoke “${request.name}”? New uploads through this request will stop immediately.`)) return;
                    void runRequestAction(`revoke:${request.id}`, () => onRevoke(request.id));
                  }}
                  title="Revoke"
                >
                  {requestAction === `revoke:${request.id}`
                    ? <RefreshCw className="spin" size={15} />
                    : <X size={15} />}
                </button>
              )}
            </article>
          )) : (
            <EmptyState icon={<Link2 size={24} />} title="No requests yet">
              Create a private upload inbox for a client, collaborator, or friend.
            </EmptyState>
          )}
        </section>
      </div>
      {qr && (
        <div className="dialog-backdrop" onClick={() => setQr(null)}>
          <div className="dialog qr-dialog" onClick={(event) => event.stopPropagation()}>
            <img src={qr.dataUrl} alt="File request QR code" />
            <h3>Scan to send files</h3>
            <p>The private token stays inside this QR code.</p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                disabled={requestBusy}
                onClick={() => void runRequestAction(
                  `save-qr:${qr.id}`,
                  () => onSaveQr(qr.id)
                )}
              >
                {requestAction === `save-qr:${qr.id}`
                  ? <RefreshCw className="spin" size={15} />
                  : null} Save PNG
              </button>
              <button className="primary-button" onClick={() => setQr(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StorageIntelligencePage({
  groups,
  onScan,
  onTrash
}: {
  groups: AppSnapshot["duplicateGroups"];
  onScan: () => Promise<void>;
  onTrash: (ids: string[]) => Promise<void>;
}) {
  const reclaimable = groups.reduce((total, group) => total + group.reclaimableBytes, 0);
  const [storageAction, setStorageAction] = useState<string | null>(null);
  const storageActionInFlight = useRef(false);

  const runStorageAction = async (key: string, action: () => Promise<void>) => {
    if (storageActionInFlight.current) return;
    storageActionInFlight.current = true;
    setStorageAction(key);
    try {
      await action();
    } finally {
      storageActionInFlight.current = false;
      setStorageAction(null);
    }
  };

  return (
    <div className="storage-intelligence">
      <section className="card storage-summary">
        <div><Layers3 size={28} /></div>
        <span className="eyebrow">Content-aware cleanup</span>
        <h2>{groups.length ? formatBytes(reclaimable) : "Ready to scan"}</h2>
        <p>{groups.length ? "potentially reclaimable from exact or clearly labelled name-and-size matches" : "PocketDock uses SHA-256 for exact matches and labels weaker name-and-size suggestions separately."}</p>
        <button
          className="primary-button"
          disabled={Boolean(storageAction)}
          onClick={() => void runStorageAction("scan", onScan)}
        >
          {storageAction === "scan" ? <RefreshCw className="spin" size={16} /> : <ScanLine size={16} />} {storageAction === "scan" ? "Scanning…" : "Scan transfer library"}
        </button>
      </section>
      <section className="card duplicate-groups">
        <div className="card-heading compact"><div><span className="eyebrow">Review first</span><h3>Duplicate groups</h3></div></div>
        {groups.length ? groups.map((group) => {
          const removable = group.items.slice(1);
          return (
            <article className="duplicate-group" key={group.id}>
              <div className="duplicate-group-head">
                <div><strong>{group.label}</strong><span>{group.items.length} copies · {formatBytes(group.reclaimableBytes)} reclaimable · {group.kind === "exact" ? "SHA-256 exact" : "name and size match"}</span></div>
                <button
                  className="secondary-button danger"
                  disabled={group.kind !== "exact" || !removable.length || Boolean(storageAction)}
                  title={group.kind === "exact"
                    ? "Move verified duplicate extras to the Recycle Bin"
                    : "Name-and-size matches require manual review; PocketDock will not remove them automatically"}
                  onClick={() => {
                    const evidence = group.kind === "exact"
                      ? "Every suggested copy has the same SHA-256 content hash."
                      : "These files only match by name and size; their contents may still differ.";
                    if (!window.confirm(
                      `Keep the first copy and move ${removable.length} duplicate file${removable.length === 1 ? "" : "s"} to the Recycle Bin? ${evidence}`
                    )) return;
                    void runStorageAction(`trash:${group.id}`, () => onTrash(removable.map((item) => item.transferId)));
                  }}
                >
                  {storageAction === `trash:${group.id}` ? <RefreshCw className="spin" size={14} /> : <Trash2 size={14} />}
                  {group.kind === "exact" ? "Recycle extras" : "Review manually"}
                </button>
              </div>
              {group.items.map((item, index) => (
                <div className="duplicate-item" key={item.transferId}>
                  {fileIcon(item.fileName, 17)}
                  <span><strong>{item.fileName}</strong><small>{item.savedPath}</small></span>
                  <em>{index === 0 ? "Keep" : formatBytes(item.size)}</em>
                </div>
              ))}
            </article>
          );
        }) : (
          <EmptyState icon={<ShieldCheck size={25} />} title="No duplicate groups loaded">
            Run a scan. PocketDock labels the match evidence and never deletes automatically.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function RecoveryCenterPage({
  issues,
  snapshots,
  service,
  onScan,
  onResolve,
  onCreateSnapshot,
  onRestoreSnapshot,
  onService
}: {
  issues: AppSnapshot["recoveryIssues"];
  snapshots: AppSnapshot["backupSnapshots"];
  service: AppSnapshot["backgroundService"];
  onScan: () => Promise<void>;
  onResolve: (id: string) => Promise<void>;
  onCreateSnapshot: () => Promise<void>;
  onRestoreSnapshot: (id: string) => Promise<void>;
  onService: (enabled: boolean) => Promise<void>;
}) {
  const [recoveryAction, setRecoveryAction] = useState<string | null>(null);
  const recoveryActionInFlight = useRef(false);

  const runRecoveryAction = async (key: string, action: () => Promise<void>) => {
    if (recoveryActionInFlight.current) return;
    recoveryActionInFlight.current = true;
    setRecoveryAction(key);
    try {
      await action();
    } finally {
      recoveryActionInFlight.current = false;
      setRecoveryAction(null);
    }
  };

  return (
    <div className="recovery-layout">
      <section className="card recovery-overview">
        <div className={`recovery-state ${issues.some((item) => item.severity === "critical") ? "critical" : issues.length ? "warning" : "healthy"}`}>
          <ArchiveRestore size={30} />
        </div>
        <span className="eyebrow">Safe repair tools</span>
        <h2>{issues.length ? `${issues.length} item${issues.length === 1 ? "" : "s"} to review` : "Everything looks recoverable"}</h2>
        <p>Interrupted staging files, unavailable destinations, stale history, and expired shares are checked locally.</p>
        <button
          className="primary-button"
          disabled={Boolean(recoveryAction)}
          onClick={() => void runRecoveryAction("scan", onScan)}
        >
          <RefreshCw className={recoveryAction === "scan" ? "spin" : ""} size={16} />
          {recoveryAction === "scan" ? "Scanning…" : "Run recovery scan"}
        </button>
        <div className="service-status">
          <div>
            <strong>Windows background service</strong>
            <span>{service.detail}</span>
          </div>
          <Toggle
            label="Windows background service"
            checked={service.installed}
            disabled={!service.supported || Boolean(recoveryAction)}
            onChange={(enabled) => void runRecoveryAction(
              "service",
              () => onService(enabled)
            )}
          />
        </div>
      </section>
      <section className="card recovery-issues">
        <div className="card-heading compact"><div><span className="eyebrow">Recovery queue</span><h3>Issues and recommendations</h3></div></div>
        {issues.length ? issues.map((issue) => (
          <article className={`recovery-issue ${issue.severity}`} key={issue.id}>
            <div>{issue.severity === "critical" ? <AlertTriangle size={18} /> : issue.severity === "warning" ? <Clock3 size={18} /> : <Info size={18} />}</div>
            <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
            <button
              className="secondary-button"
              disabled={!issue.recoverable || Boolean(recoveryAction)}
              onClick={() => {
                if (!window.confirm(
                  `Apply the recommended recovery action for “${issue.title}”? Review the detail carefully: recovery can remove stale records or abandoned staging data.`
                )) return;
                void runRecoveryAction(`resolve:${issue.id}`, () => onResolve(issue.id));
              }}
            >
              {recoveryAction === `resolve:${issue.id}` ? "Resolving…" : issue.recoverable ? "Resolve safely" : "Manual repair"}
            </button>
          </article>
        )) : (
          <EmptyState icon={<CheckCircle2 size={25} />} title="Recovery queue is clear">
            PocketDock found no interrupted or stale local state.
          </EmptyState>
        )}
      </section>
      <section className="card restore-points">
        <div className="card-heading compact">
          <div><span className="eyebrow">Version history</span><h3>Verified restore points</h3></div>
          <button
            className="secondary-button"
            disabled={Boolean(recoveryAction)}
            onClick={() => void runRecoveryAction("snapshot:create", onCreateSnapshot)}
          >
            {recoveryAction === "snapshot:create" ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />} Create now
          </button>
        </div>
        <p className="section-note">
          Content-addressed storage keeps one verified object per unique file. Daily, weekly, and monthly retention is applied automatically.
        </p>
        {snapshots.length ? snapshots.slice(0, 12).map((snapshot) => (
          <article className="restore-point" key={snapshot.id}>
            <div><ArchiveRestore size={18} /></div>
            <span>
              <strong>{formatDate(snapshot.createdAt)} · {snapshot.reason}</strong>
              <small>{snapshot.fileCount} files · {formatBytes(snapshot.totalBytes)} · {formatBytes(snapshot.uniqueBytes)} new storage</small>
            </span>
            <button
              className="secondary-button"
              disabled={!snapshot.fileCount || Boolean(recoveryAction)}
              onClick={() => {
                if (window.confirm("Restore this version into a new PocketDock Restores folder? Existing files will not be overwritten.")) {
                  void runRecoveryAction(
                    `snapshot:restore:${snapshot.id}`,
                    () => onRestoreSnapshot(snapshot.id)
                  );
                }
              }}
            >
              {recoveryAction === `snapshot:restore:${snapshot.id}` ? "Restoring…" : "Restore"}
            </button>
          </article>
        )) : (
          <EmptyState icon={<ArchiveRestore size={25} />} title="No restore points yet">
            Create one now, or enable scheduled backup to capture one automatically inside the backup window.
          </EmptyState>
        )}
      </section>
    </div>
  );
}

function SettingsPage({
  settings,
  connection,
  trustedDevices,
  rules,
  onChooseDestination,
  onUpdate,
  onRotatePin,
  onOpenOnboarding,
  onRevokeDevice,
  onUpdateDevicePermissions,
  onAddRule,
  onRemoveRule,
  onInstallExplorer,
  onConfigureFirewall,
  onRunDiagnostics,
  onExportDiagnostics,
  onCheckUpdates
}: {
  settings: AppSettings;
  connection: AppSnapshot["connection"];
  trustedDevices: TrustedDevice[];
  rules: AutomationRule[];
  onChooseDestination: () => void;
  onUpdate: (patch: Partial<AppSettings>, message?: string) => void;
  onRotatePin: () => void;
  onOpenOnboarding: () => void;
  onRevokeDevice: (id: string) => Promise<void>;
  onUpdateDevicePermissions: (id: string, permissions: DevicePermissions) => Promise<void>;
  onAddRule: (rule: Omit<AutomationRule, "id">) => Promise<void>;
  onRemoveRule: (id: string) => Promise<void>;
  onInstallExplorer: () => void;
  onConfigureFirewall: () => void;
  onRunDiagnostics: () => Promise<DiagnosticReport>;
  onExportDiagnostics: () => void;
  onCheckUpdates: () => void;
}) {
  const [deviceName, setDeviceName] = useState(settings.deviceName);
  const [port, setPort] = useState(settings.port.toString());
  const [ruleExtension, setRuleExtension] = useState("");
  const [ruleFolder, setRuleFolder] = useState("");
  const [ruleAction, setRuleAction] = useState<NonNullable<AutomationRule["action"]>>("move");
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport | null>(null);
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [settingsAction, setSettingsAction] = useState<string | null>(null);
  const settingsActionInFlight = useRef(false);
  const t = (value: string) => translate(value, settings.language);

  useEffect(() => {
    setDeviceName(settings.deviceName);
    setPort(settings.port.toString());
  }, [settings.deviceName, settings.port]);

  const runHealthCheck = async () => {
    setDiagnosticsRunning(true);
    setDiagnosticsError(null);
    try {
      setDiagnostics(await onRunDiagnostics());
    } catch (error) {
      setDiagnostics(null);
      setDiagnosticsError(messageFromError(error, "System diagnostics could not be completed."));
    } finally {
      setDiagnosticsRunning(false);
    }
  };

  const runSettingsAction = async (key: string, action: () => Promise<void>) => {
    if (settingsActionInFlight.current) return;
    settingsActionInFlight.current = true;
    setSettingsAction(key);
    try {
      await action();
    } finally {
      settingsActionInFlight.current = false;
      setSettingsAction(null);
    }
  };

  useEffect(() => {
    void runHealthCheck();
  }, []);

  return (
    <div className="settings-layout">
      <section className="settings-section card health-center">
        <div className="health-header">
          <div className="settings-heading">
            <div className="settings-icon mint"><HeartPulse size={21} /></div>
            <div>
              <h3>System Health Center</h3>
              <p>Live checks for storage, network, encryption, database, relay, and device trust.</p>
            </div>
          </div>
          <div className="health-actions">
            <button
              className="secondary-button"
              disabled={diagnosticsRunning}
              onClick={() => void runHealthCheck()}
            >
              <RefreshCw className={diagnosticsRunning ? "spin" : ""} size={15} />
              {diagnosticsRunning ? "Checking…" : "Run checks"}
            </button>
            <button className="primary-button" onClick={onExportDiagnostics}>
              <Download size={15} /> Export report
            </button>
          </div>
        </div>
        {diagnostics ? (
          <>
            <div className="health-summary">
              <div className={diagnostics.checks.some((check) => check.status === "fail") ? "fail" : diagnostics.checks.some((check) => check.status === "warning") ? "warning" : "pass"}>
                {diagnostics.checks.some((check) => check.status === "fail")
                  ? <AlertTriangle size={22} />
                  : <ShieldCheck size={22} />}
              </div>
              <strong>
                {diagnostics.checks.some((check) => check.status === "fail")
                  ? "Attention needed"
                  : diagnostics.checks.some((check) => check.status === "warning")
                    ? "Healthy with recommendations"
                    : "All systems healthy"}
              </strong>
              <span>
                {diagnostics.checks.filter((check) => check.status === "pass").length} passed ·{" "}
                {diagnostics.checks.filter((check) => check.status === "warning").length} recommendations ·{" "}
                {diagnostics.checks.filter((check) => check.status === "fail").length} failed
              </span>
              <em>Checked {formatDate(diagnostics.generatedAt)}</em>
            </div>
            <div className="health-check-grid">
              {diagnostics.checks.map((check) => (
                <div className={`health-check ${check.status}`} key={check.id}>
                  <div>
                    {check.status === "pass"
                      ? <CheckCircle2 size={16} />
                      : check.status === "warning"
                        ? <AlertTriangle size={16} />
                        : <X size={16} />}
                  </div>
                  <span><strong>{check.label}</strong><small>{check.detail}</small></span>
                </div>
              ))}
            </div>
          </>
        ) : diagnosticsError ? (
          <div className="inline-action-status error diagnostics-error" role="alert">
            <AlertTriangle size={18} />
            <span><strong>Health scan failed</strong><small>{diagnosticsError}</small></span>
            <button className="secondary-button" onClick={() => void runHealthCheck()}>
              <RotateCcw size={14} /> Retry
            </button>
          </div>
        ) : (
          <div className="health-loading"><div className="loader" /> Running a private local health scan…</div>
        )}
      </section>
      <section className="settings-section card">
        <div className="settings-heading">
          <div className="settings-icon"><FolderOpen size={20} /></div>
          <div><h3>Received files</h3><p>Choose where incoming items land.</p></div>
        </div>
        <div className="setting-row stacked">
          <label>Save location</label>
          <button className="path-picker" onClick={onChooseDestination}>
            <FolderOpen size={18} />
            <span title={settings.destinationDirectory}>{settings.destinationDirectory}</span>
            <strong>Change</strong>
          </button>
          <p className="field-help">
            Synced OneDrive, Dropbox, Google Drive Desktop, and mapped NAS folders work here too.
          </p>
        </div>
        <div className="setting-row">
          <div><label>When a file already exists</label><p>Protect old copies or replace them.</p></div>
          <select
            value={settings.conflictPolicy}
            onChange={(event) =>
              onUpdate(
                { conflictPolicy: event.target.value as AppSettings["conflictPolicy"] },
                "File conflict rule updated."
              )
            }
          >
            <option value="rename">Keep both</option>
            <option value="replace">Replace existing</option>
            <option value="skip">Skip new file</option>
          </select>
        </div>
        <div className="setting-row">
          <div><label>Simultaneous transfers</label><p>Lower this on slower Wi-Fi.</p></div>
          <select
            value={settings.maxConcurrentUploads}
            onChange={(event) =>
              onUpdate({ maxConcurrentUploads: Number(event.target.value) })
            }
          >
            <option value="1">1 at a time</option>
            <option value="2">2 at a time</option>
            <option value="3">3 at a time</option>
            <option value="4">4 at a time</option>
          </select>
        </div>
        <div className="setting-row">
          <div><label>Organize incoming files</label><p>Create useful folders automatically.</p></div>
          <select
            value={settings.organizeMode}
            onChange={(event) =>
              onUpdate({ organizeMode: event.target.value as AppSettings["organizeMode"] })
            }
          >
            <option value="none">Keep original layout</option>
            <option value="date">Year and month</option>
            <option value="type">File type</option>
            <option value="device">Sending device</option>
            <option value="rules">Automation rules</option>
          </select>
        </div>
        <div className="setting-row">
          <div><label>Identical files</label><p>SHA-256 finds duplicates even with different names.</p></div>
          <select
            value={settings.duplicatePolicy}
            onChange={(event) =>
              onUpdate({ duplicatePolicy: event.target.value as AppSettings["duplicatePolicy"] })
            }
          >
            <option value="skip-identical">Skip identical content</option>
            <option value="keep">Always keep a copy</option>
          </select>
        </div>
      </section>

      <section className="settings-section card">
        <div className="settings-heading">
          <div className="settings-icon mint"><ShieldCheck size={20} /></div>
          <div><h3>Security & trusted devices</h3><p>Encryption, verification, and remembered iPhones.</p></div>
        </div>
        <div className="setting-row">
          <div><label>AES-256 transfer encryption</label><p>Encrypt every chunk before it leaves the iPhone.</p></div>
          <Toggle
            label="Transfer encryption"
            checked={settings.encryptTransfers}
            disabled={Boolean(settingsAction)}
            onChange={(value) => onUpdate({ encryptTransfers: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>SHA-256 verification</label><p>Compare the complete file before saving it.</p></div>
          <Toggle
            label="Integrity verification"
            checked={settings.verifyIntegrity}
            disabled={Boolean(settingsAction)}
            onChange={(value) => onUpdate({ verifyIntegrity: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Remember trusted devices</label><p>Reconnect without entering a PIN every time.</p></div>
          <Toggle
            label="Trusted device reconnection"
            checked={settings.trustedDeviceAutoConnect}
            disabled={Boolean(settingsAction)}
            onChange={(value) => onUpdate({ trustedDeviceAutoConnect: value })}
          />
        </div>
        <div className="trusted-list">
          {trustedDevices.length ? trustedDevices.map((device) => (
            <div className={`trusted-device ${device.revoked ? "revoked" : ""}`} key={device.id}>
              <Smartphone size={18} />
              <div>
                <strong>{device.name}</strong>
                <span>{device.revoked ? "Revoked" : `Last seen ${formatDate(device.lastSeenAt)}`}</span>
              </div>
              {!device.revoked && (
                <button
                  className="secondary-button danger"
                  disabled={Boolean(settingsAction)}
                  onClick={() => {
                    if (!window.confirm(`Revoke “${device.name}”? It will lose all PocketDock permissions and must pair again.`)) return;
                    void runSettingsAction(`device:revoke:${device.id}`, () => onRevokeDevice(device.id));
                  }}
                >
                  {settingsAction === `device:revoke:${device.id}` ? "Revoking…" : "Revoke"}
                </button>
              )}
              {!device.revoked && (
                <div className="device-permissions">
                  {([
                    ["sendToPc", "Send to PC"],
                    ["receiveFromPc", "Receive from PC"],
                    ["clipboard", "Clipboard"],
                    ["automaticBackup", "Automatic backup"],
                    ["remoteAccess", "Remote access"],
                    ["browseFiles", "Browse Drive"],
                    ["fileProvider", "Files app integration"],
                    ["fileRequests", "File requests"]
                  ] as const).map(([permission, label]) => (
                    <label key={permission}>
                      <Toggle
                        label={`${label} for ${device.name}`}
                        checked={device.permissions[permission]}
                        disabled={Boolean(settingsAction)}
                        onChange={(value) => void runSettingsAction(
                          `device:permissions:${device.id}`,
                          () => onUpdateDevicePermissions(device.id, {
                            ...device.permissions,
                            [permission]: value
                          })
                        )}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )) : <p className="settings-empty">Paired iPhones will appear here.</p>}
        </div>
      </section>

      <section className="settings-section card">
        <div className="settings-heading">
          <div className="settings-icon"><Sparkles size={20} /></div>
          <div><h3>Organization rules</h3><p>Route matching files into specific folders.</p></div>
        </div>
        <div className="rule-builder">
          <input
            value={ruleExtension}
            disabled={Boolean(settingsAction)}
            onChange={(event) => setRuleExtension(event.target.value)}
            placeholder="Extension, e.g. wav"
          />
          <input
            value={ruleFolder}
            disabled={Boolean(settingsAction)}
            onChange={(event) => setRuleFolder(event.target.value)}
            placeholder="Folder, e.g. Beats"
          />
          <select disabled={Boolean(settingsAction)} value={ruleAction} onChange={(event) => setRuleAction(event.target.value as NonNullable<AutomationRule["action"]>)}>
            <option value="move">Move into folder</option>
            <option value="tag">Tag in library</option>
            <option value="share">Share to iPhone</option>
            <option value="vault">Add to vault queue</option>
            <option value="producer">Build producer delivery</option>
          </select>
          <button
            className="primary-button"
            disabled={!ruleExtension.trim() || !ruleFolder.trim() || Boolean(settingsAction)}
            onClick={() => void runSettingsAction("rule:add", async () => {
              await onAddRule({
                name: `${ruleExtension.toUpperCase()} → ${ruleFolder}`,
                enabled: true,
                matcher: "extension",
                value: ruleExtension,
                destinationSubfolder: ruleFolder,
                action: ruleAction,
                actionValue: ruleFolder
              });
              setRuleExtension("");
              setRuleFolder("");
            })}
          >
            {settingsAction === "rule:add" ? <RefreshCw className="spin" size={15} /> : <Plus size={15} />} Add
          </button>
        </div>
        <div className="rules-list">
          {rules.map((rule) => (
            <div className="rule-item" key={rule.id}>
              <div><strong>{rule.name}</strong><span>{rule.matcher}: {rule.value || "everything"}</span></div>
              <em>{rule.action ?? "move"} → {rule.actionValue || rule.destinationSubfolder}</em>
              <button
                className="icon-button small"
                disabled={Boolean(settingsAction)}
                onClick={() => {
                  if (!window.confirm(`Remove the automation rule “${rule.name}”? Files already organized by it will stay where they are.`)) return;
                  void runSettingsAction(`rule:remove:${rule.id}`, () => onRemoveRule(rule.id));
                }}
                title={`Remove ${rule.name}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {!rules.length && <p className="settings-empty">Add a rule, then choose “Automation rules” under Received files.</p>}
        </div>
      </section>

      <section className="settings-section card">
        <div className="settings-heading">
          <div className="settings-icon mint"><Wifi size={20} /></div>
          <div><h3>Connection</h3><p>Name this PC and control pairing.</p></div>
        </div>
        <div className="setting-row stacked">
          <label htmlFor="device-name">PC name shown on iPhone</label>
          <div className="input-action">
            <input
              id="device-name"
              value={deviceName}
              maxLength={80}
              onChange={(event) => setDeviceName(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={!deviceName.trim() || deviceName === settings.deviceName}
              onClick={() => onUpdate({ deviceName: deviceName.trim() }, "PC name updated.")}
            >
              Save
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div><label>Pairing code</label><p>Generate a new code whenever you want.</p></div>
          <div className="pin-setting">
            <strong>{connection.pin.slice(0, 3)} {connection.pin.slice(3)}</strong>
            <button className="secondary-button" onClick={onRotatePin}>
              <RotateCcw size={15} /> New code
            </button>
          </div>
        </div>
        <div className="setting-row stacked">
          <label htmlFor="network-port">Network port</label>
          <div className="input-action narrow">
            <input
              id="network-port"
              type="number"
              min="1024"
              max="65535"
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={Number(port) === settings.port || Number(port) < 1024 || Number(port) > 65535}
              onClick={() => onUpdate({ port: Number(port) }, "Transfer service restarted.")}
            >
              Apply
            </button>
          </div>
          <p className="field-help">
            Windows Firewall may ask once for permission on private networks.
          </p>
        </div>
      </section>

      <section className="settings-section card">
        <div className="settings-heading">
          <div className="settings-icon coral"><Sparkles size={20} /></div>
          <div><h3>App experience</h3><p>Startup, notifications, and appearance.</p></div>
        </div>
        <div className="setting-row">
          <div><label>Start with Windows</label><p>Keep PocketDock ready after sign-in.</p></div>
          <Toggle
            label="Start with Windows"
            checked={settings.runAtLogin}
            onChange={(value) => onUpdate({ runAtLogin: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Close to system tray</label><p>Transfers can continue in the background.</p></div>
          <Toggle
            label="Close to system tray"
            checked={settings.minimizeToTray}
            onChange={(value) => onUpdate({ minimizeToTray: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Transfer notifications</label><p>Get a Windows alert when a file arrives.</p></div>
          <Toggle
            label="Transfer notifications"
            checked={settings.showNotifications}
            onChange={(value) => onUpdate({ showNotifications: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Appearance</label><p>Choose what feels best on this PC.</p></div>
          <div className="theme-picker">
            {([
              ["system", MonitorDown],
              ["light", Sun],
              ["dark", Moon]
            ] as const).map(([theme, Icon]) => (
              <button
                key={theme}
                title={theme[0].toUpperCase() + theme.slice(1)}
                className={settings.theme === theme ? "active" : ""}
                onClick={() => onUpdate({ theme })}
              >
                <Icon size={17} />
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div><label>Interface density</label><p>Fit more files or give every control more room.</p></div>
          <select
            value={settings.interfaceDensity}
            onChange={(event) =>
              onUpdate({ interfaceDensity: event.target.value as AppSettings["interfaceDensity"] })
            }
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </select>
        </div>
        <div className="setting-row stacked">
          <label htmlFor="interface-scale">Interface scale · {Math.round(settings.interfaceScale * 100)}%</label>
          <input
            id="interface-scale"
            type="range"
            min="0.85"
            max="1.4"
            step="0.05"
            value={settings.interfaceScale}
            onChange={(event) => onUpdate({ interfaceScale: Number(event.target.value) })}
          />
        </div>
        <div className="setting-row">
          <div><label>High-contrast status colors</label><p>Strengthen boundaries, text, and state indicators.</p></div>
          <Toggle
            label="High-contrast interface"
            checked={settings.highContrast}
            onChange={(value) => onUpdate({ highContrast: value })}
          />
        </div>
      </section>

      <section className="settings-section card">
        <div className="settings-heading">
          <div className="settings-icon gray"><Settings size={20} /></div>
          <div><h3>Windows & advanced</h3><p>System integration, limits, remote access, and updates.</p></div>
        </div>
        <div className="setting-row">
          <div><label>Shared clipboard</label><p>Exchange text and URLs between devices.</p></div>
          <Toggle
            label="Shared clipboard"
            checked={settings.clipboardSharing}
            onChange={(value) => onUpdate({ clipboardSharing: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Automatic clipboard continuity</label><p>Publish new Windows text automatically to trusted iPhones.</p></div>
          <Toggle
            label="Automatic clipboard continuity"
            checked={settings.automaticClipboardSync}
            onChange={(value) => onUpdate({ automaticClipboardSync: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Connection strategy</label><p>Choose how PocketDock ranks LAN and private-relay file transfers.</p></div>
          <select
            value={settings.connectionStrategy}
            onChange={(event) =>
              onUpdate({ connectionStrategy: event.target.value as AppSettings["connectionStrategy"] })
            }
          >
            <option value="automatic">Automatic · fastest available</option>
            <option value="lan-first">Local Wi-Fi first</option>
            <option value="relay-first">Remote relay first</option>
          </select>
        </div>
        <div className="setting-row">
          <div><label>USB Camera Roll import</label><p>Detect unlocked DCIM access separately from normal file transfers.</p></div>
          <Toggle
            label="USB Camera Roll import"
            checked={settings.allowUsbImport}
            onChange={(value) => onUpdate({ allowUsbImport: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Explorer right-click menu</label><p>Send a file without opening the dashboard first.</p></div>
          <button className="secondary-button" onClick={onInstallExplorer}>Install</button>
        </div>
        <div className="setting-row">
          <div><label>Windows Firewall</label><p>Allow this PocketDock app on trusted private networks.</p></div>
          <button className="secondary-button" onClick={onConfigureFirewall}>Configure</button>
        </div>
        <div className="setting-row">
          <div><label>System Health Center</label><p>Live checks and redacted export are shown at the top of Settings.</p></div>
          <span className="ready-label"><HeartPulse size={14} /> Live</span>
        </div>
        <div className="setting-row stacked">
          <label>Bandwidth limit in Mbps</label>
          <div className="input-action narrow">
            <input
              type="number"
              min="0"
              max="10000"
              defaultValue={settings.bandwidthLimitMbps}
              onBlur={(event) => onUpdate({ bandwidthLimitMbps: Number(event.target.value) || 0 })}
            />
            <span className="input-suffix">0 = unlimited</span>
          </div>
        </div>
        <div className="setting-row">
          <div><label>Automatic updates</label><p>Use a signed generic update channel when configured.</p></div>
          <div className="inline-setting-actions">
            <Toggle
              label="Automatic updates"
              checked={settings.autoUpdate}
              onChange={(value) => onUpdate({ autoUpdate: value })}
            />
            <button className="secondary-button" onClick={onCheckUpdates}>Check</button>
          </div>
        </div>
        <div className="setting-row stacked">
          <label>Update feed URL</label>
          <input
            defaultValue={settings.updateFeedUrl}
            placeholder="https://updates.example.com/pocketdock"
            onBlur={(event) => onUpdate({ updateFeedUrl: event.target.value.trim() })}
          />
        </div>
        <div className="setting-row">
          <div>
            <label>Remote relay</label>
            <p>Configure the operational native-client bridge under Sync & Backup.</p>
          </div>
          <span className="ready-label">Native app</span>
        </div>
        <div className="setting-row">
          <div><label>{t("Language")}</label><p>{t("The interface follows Windows unless overridden.")}</p></div>
          <select
            value={settings.language}
            onChange={(event) =>
              onUpdate({ language: event.target.value as AppSettings["language"] })
            }
          >
            <option value="system">{t("Windows default")}</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </div>
        <div className="setting-row">
          <div><label>Pause automatic backup on battery</label><p>The native app avoids unattended heavy transfers when unplugged.</p></div>
          <Toggle
            label="Pause backup on battery"
            checked={settings.pauseBackupOnBattery}
            onChange={(value) => onUpdate({ pauseBackupOnBattery: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Pause backup on metered networks</label><p>Protect cellular and constrained network allowances.</p></div>
          <Toggle
            label="Pause backup on metered networks"
            checked={settings.pauseBackupOnMeteredNetwork}
            onChange={(value) => onUpdate({ pauseBackupOnMeteredNetwork: value })}
          />
        </div>
        <div className="setting-row">
          <div><label>Scheduled backup window</label><p>Run unattended backup and watch jobs only during the selected hours.</p></div>
          <Toggle
            label="Scheduled backup window"
            checked={settings.backupScheduleEnabled}
            onChange={(value) => onUpdate({ backupScheduleEnabled: value })}
          />
        </div>
        <div className="setting-row schedule-window">
          <label>From<input type="time" value={settings.backupWindowStart} onChange={(event) => onUpdate({ backupWindowStart: event.target.value })} /></label>
          <label>Until<input type="time" value={settings.backupWindowEnd} onChange={(event) => onUpdate({ backupWindowEnd: event.target.value })} /></label>
        </div>
        <div className="setting-row retention-grid">
          <label>Daily retention<input type="number" min="1" max="3650" value={settings.backupRetentionDays} onChange={(event) => onUpdate({ backupRetentionDays: Number(event.target.value) })} /><span>days</span></label>
          <label>Weekly versions<input type="number" min="0" max="104" value={settings.backupWeeklyVersions} onChange={(event) => onUpdate({ backupWeeklyVersions: Number(event.target.value) })} /></label>
          <label>Monthly versions<input type="number" min="0" max="120" value={settings.backupMonthlyVersions} onChange={(event) => onUpdate({ backupMonthlyVersions: Number(event.target.value) })} /></label>
        </div>
        <div className="setting-row stacked">
          <label>Vault auto-lock minutes</label>
          <input
            type="number"
            min="1"
            max="240"
            defaultValue={settings.vaultAutoLockMinutes}
            onBlur={(event) =>
              onUpdate({ vaultAutoLockMinutes: Number(event.target.value) || 15 })
            }
          />
        </div>
      </section>

      <section className="settings-section card about-card">
        <div className="settings-heading">
          <div className="settings-icon gray"><Info size={20} /></div>
          <div><h3>Help & about</h3><p>PocketDock keeps transfers direct and understandable.</p></div>
        </div>
        <button className="setting-link" onClick={onOpenOnboarding}>
          <span><CircleHelp size={18} /> Show quick start</span><ChevronRight size={17} />
        </button>
        <div className="setting-link static">
          <span><ShieldCheck size={18} /> Privacy</span>
          <em>AES-256 + SHA-256</em>
        </div>
      </section>
    </div>
  );
}

export default App;
