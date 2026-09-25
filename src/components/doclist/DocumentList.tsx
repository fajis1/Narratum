'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useLiveQuery } from 'dexie-react-hooks';
import { useDocuments } from '@/contexts/DocumentContext';
import type {
  DocumentListDocument,
  DocumentListState,
  Folder,
  IconSize,
  SidebarFilter,
  SortBy,
  SortDirection,
  ViewMode,
} from '@/types/documents';
import {
  getDocumentListState,
  getDocumentRecentlyOpenedMap,
  saveDocumentListState,
} from '@/lib/client/dexie';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { BatchAudiobookSidebar } from './BatchAudiobookSidebar';
import { CreateFolderDialog } from '@/components/doclist/CreateFolderDialog';
import { DocumentListSkeleton } from '@/components/doclist/DocumentListSkeleton';
import { DocumentUploader, type UploadBatchState } from '@/components/documents/DocumentUploader';
import { Button, IconButton } from '@/components/ui';
import { UploadMenuDialog } from '@/components/documents/UploadMenuDialog';
import { DocumentDndProvider } from './dnd/DocumentDndProvider';
import {
  DocumentSelectionProvider,
  useDocumentSelection,
} from './dnd/DocumentSelectionContext';
import { documentIdentityKey, type DocumentDragItem } from './dnd/dndTypes';
import { FinderWindow, useIsNarrow } from './window/FinderWindow';
import { AudiobookQuotaCard } from './window/AudiobookQuotaCard';
import { FinderToolbar } from './window/FinderToolbar';
import { FinderSidebar } from './window/FinderSidebar';
import { FinderStatusBar } from './window/FinderStatusBar';
import { IconsView } from './views/IconsView';
import { ListView } from './views/ListView';
import { GalleryView } from './views/GalleryView';
import { JobsInlineView } from './views/JobsInlineView';
import { ScanForeignWordsModal } from './ScanForeignWordsModal';
import { BookPronunciationInspectorModal } from './BookPronunciationInspectorModal';
import { MultiVoiceCharacterModal } from './MultiVoiceCharacterModal';
import { DocumentSelectionModal } from '@/components/documents/DocumentSelectionModal';
import { PDFIcon } from '@/components/icons/Icons';
import { AudiobookshelfModal } from '@/components/audiobooks/AudiobookshelfModal';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import type { SmartAudioProfile } from '@/types/client';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { getNarratorVoiceId } from '@/lib/shared/multi-voice';
import {
  CLOUD_TTS_CHARACTER_VOICE_SET,
  CLOUD_TTS_FEMALE_VOICES,
  CLOUD_TTS_MODEL,
} from '@/lib/shared/google-cloud-tts-voices';
import { AUDIOBOOK_QUOTA_UPDATED_EVENT } from '@/lib/shared/audiobook-quota';

let cachedDocumentListState: DocumentListState | null = null;

type DocumentToDelete = {
  id: string;
  name: string;
  type: DocumentListDocument['type'];
  isAudiobookView?: boolean;
};

const DEFAULT_STATE: Required<
  Pick<
    DocumentListState,
    'sortBy' | 'sortDirection' | 'folders' | 'collapsedFolders' | 'showHint'
  >
> & {
  viewMode: ViewMode;
  iconSize: IconSize;
  sidebarWidth: number;
  sidebarFilter: SidebarFilter;
  sidebarCollapsed: boolean;
} = {
  sortBy: 'name',
  sortDirection: 'asc',
  folders: [],
  collapsedFolders: [],
  showHint: true,
  viewMode: 'icons',
  iconSize: 'md',
  sidebarWidth: 220,
  sidebarFilter: 'all',
  sidebarCollapsed: false,
};

function normalizeViewMode(stored: DocumentListState['viewMode']): ViewMode {
  if (stored === 'grid' || stored === undefined) return 'icons';
  if (stored === 'list') return 'list';
  if (stored === 'gallery') return 'gallery';
  return 'icons';
}

function generateDefaultFolderName(
  doc1: DocumentListDocument,
  doc2: DocumentListDocument,
): string {
  const words1 = doc1.name.toLowerCase().split(/[\s\-_.]+/);
  const words2 = doc2.name.toLowerCase().split(/[\s\-_.]+/);
  const common = words1.filter((w) => words2.includes(w));
  const significant = common.find((w) => w.length >= 3);
  if (significant) {
    if (significant === 'pdf') return 'PDFs';
    if (significant === 'epub') return 'EPUBs';
    if (significant === 'txt' || significant === 'md') return 'Documents';
    return significant.charAt(0).toUpperCase() + significant.slice(1);
  }
  const timestamp = new Date().toISOString().slice(0, 10);
  return `Folder ${timestamp}`;
}

function sortDocs(
  docs: DocumentListDocument[],
  sortBy: SortBy,
  direction: SortDirection,
): DocumentListDocument[] {
  const sorted = [...docs].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'type':
        return a.type.localeCompare(b.type);
      case 'size':
        return a.size - b.size;
      default:
        return a.lastModified - b.lastModified;
    }
  });
  return direction === 'asc' ? sorted : sorted.reverse();
}

interface DocumentListInnerProps {
  brand?: ReactNode;
  appActions?: ReactNode;
}

function SidebarUploadLoader({
  totalFiles,
  completedFiles,
  currentFileName,
}: {
  totalFiles: number;
  completedFiles: number;
  phase: 'uploading';
  currentFileName: string | null;
}) {
  const progress = totalFiles > 0 ? Math.min(100, Math.round((completedFiles / totalFiles) * 100)) : 0;
  const radius = 7;
  const stroke = 2;
  const size = 18;
  const normalizedRadius = radius - stroke / 2;
  const circumference = 2 * Math.PI * normalizedRadius;
  const dashOffset = circumference - (progress / 100) * circumference;

  return (
    <div className="rounded-md border border-line bg-surface-sunken px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5 text-[11px] leading-tight">
          <span className="font-medium text-foreground">Uploading</span>
          <span className="shrink-0 tabular-nums text-soft">{completedFiles}/{totalFiles}</span>
        </div>
        <div className="shrink-0 flex items-center gap-1 text-accent" aria-label={`Upload progress ${progress}%`}>
          <span className="text-[10px] tabular-nums text-soft">{progress}%</span>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={normalizedRadius}
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.2"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={normalizedRadius}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              style={{ transition: 'stroke-dashoffset 200ms ease-standard' }}
            />
          </svg>
        </div>
      </div>
      {currentFileName && (
        <p className="mt-0.5 truncate text-[10px] text-soft" title={currentFileName}>
          {currentFileName}
        </p>
      )}
    </div>
  );
}

function DocumentListStateLoader() {
  return (
    <div
      className="h-full w-full min-h-0 bg-surface-sunken animate-pulse"
      aria-label="Loading documents"
      aria-busy="true"
    />
  );
}

function DocumentListInner({ brand, appActions }: DocumentListInnerProps) {
  const router = useRouter();
  const cachedState = cachedDocumentListState;
  const [sortBy, setSortBy] = useState<SortBy>(cachedState?.sortBy ?? DEFAULT_STATE.sortBy);
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    cachedState?.sortDirection ?? DEFAULT_STATE.sortDirection,
  );
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(cachedState?.viewMode ?? DEFAULT_STATE.viewMode),
  );
  const [iconSize, setIconSize] = useState<IconSize>(cachedState?.iconSize ?? DEFAULT_STATE.iconSize);
  const [folders, setFolders] = useState<Folder[]>(cachedState?.folders ?? DEFAULT_STATE.folders);
  const [showHint, setShowHint] = useState(cachedState?.showHint ?? true);
  const [sidebarWidth, setSidebarWidth] = useState(cachedState?.sidebarWidth ?? DEFAULT_STATE.sidebarWidth);
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilter>(cachedState?.sidebarFilter ?? 'all');
  const [sidebarOpen, setSidebarOpen] = useState(!(cachedState?.sidebarCollapsed ?? false));
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeUploadBatches, setActiveUploadBatches] = useState<Record<string, UploadBatchState>>({});
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);

  const [isInitialized, setIsInitialized] = useState(cachedState !== null);

  const [documentToDelete, setDocumentToDelete] = useState<DocumentToDelete | null>(null);
  const [pendingMerge, setPendingMerge] = useState<
    | { sources: DocumentListDocument[]; target: DocumentListDocument }
    | null
  >(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [manualFolderPrompt, setManualFolderPrompt] = useState(false);
  const [clearFoldersPrompt, setClearFoldersPrompt] = useState(false);
  const [bulkDeleteAudiobooksPrompt, setBulkDeleteAudiobooksPrompt] = useState(false);
  const [showBatchAudiobookSidebar, setShowBatchAudiobookSidebar] = useState(false);
  const [backgroundJobs, setBackgroundJobs] = useState<{ id: string, documentId: string, status: string, progress: number }[] | null>(null);
  const [docToScan, setDocToScan] = useState<DocumentListDocument | null>(null);
  const [dramaCharacterScan, setDramaCharacterScan] = useState<{
    document: DocumentListDocument;
    profileId: string;
    workerMode: 'multi-voice' | 'drama-gemini-tts';
  } | null>(null);
  const [isOpeningDramaCharacterScan, setIsOpeningDramaCharacterScan] = useState(false);
  const [docToInspect, setDocToInspect] = useState<DocumentListDocument | null>(null);
  const [isActionSelectionModalOpen, setIsActionSelectionModalOpen] = useState(false);
  const [selectionModalProps, setSelectionModalProps] = useState<{
    title: string;
    confirmLabel: string;
    defaultSelected: boolean;
    onConfirmAction: (docs: DocumentListDocument[]) => void;
  }>({
    title: '',
    confirmLabel: '',
    defaultSelected: false,
    onConfirmAction: () => {},
  });
  // Audiobookshelf export state: set to a doc to open the ABS modal for it
  const [absExportDoc, setAbsExportDoc] = useState<DocumentListDocument | null>(null);

  useEffect(() => {
    // Also check if there's an old legacy localStorage batch, clear it.
    localStorage.removeItem('batchAudiobookQueue');

    const fetchQueue = async () => {
      try {
        const res = await fetch('/api/audiobooks/queue');
        if (res.ok) {
          const data = await res.json();
          const active = data.jobs?.filter((j: { status: string }) => j.status === 'queued' || j.status === 'running') || [];
          setBackgroundJobs(active.length > 0 ? active : null);
        }
      } catch (e) {
        console.error('Failed to fetch background audiobook queue', e);
      }
    };
    
    fetchQueue();
    // Poll every 10 seconds while jobs are active
    const interval = setInterval(fetchQueue, 10000);
    return () => clearInterval(interval);
  }, []);

  const isNarrow = useIsNarrow();
  const selection = useDocumentSelection();

  const {
    pdfDocs,
    isPDFLoading,
    epubDocs,
    isEPUBLoading,
    htmlDocs,
    deleteDocument,
    isHTMLLoading,
  } = useDocuments();

  const { data: audiobooksData } = useSWR('/api/audiobooks', async (url) => {
    try {
      const res = await fetch(url);
      const json = await res.json();
      return json;
    } catch {
      return { audiobooks: [], smartAudiobookIds: [], audiobookSizes: {} };
    }
  });
  const EMPTY_ARRAY: string[] = [];
  const generatedAudiobookIds = audiobooksData?.audiobooks || EMPTY_ARRAY;

  // Load saved state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await getDocumentListState();
      if (cancelled) return;
      if (saved) {
        cachedDocumentListState = saved;
        setSortBy(saved.sortBy);
        setSortDirection(saved.sortDirection);
        setFolders(saved.folders ?? []);
        setShowHint(saved.showHint ?? true);
        setViewMode(normalizeViewMode(saved.viewMode));
        setIconSize(saved.iconSize ?? DEFAULT_STATE.iconSize);
        setSidebarWidth(saved.sidebarWidth ?? DEFAULT_STATE.sidebarWidth);
        setSidebarFilter(saved.sidebarFilter ?? 'all');
        setSidebarOpen(!(saved.sidebarCollapsed ?? false));
      } else {
        cachedDocumentListState = null;
        setSortBy(DEFAULT_STATE.sortBy);
        setSortDirection(DEFAULT_STATE.sortDirection);
        setFolders(DEFAULT_STATE.folders);
        setShowHint(DEFAULT_STATE.showHint);
        setViewMode(DEFAULT_STATE.viewMode);
        setIconSize(DEFAULT_STATE.iconSize);
        setSidebarWidth(DEFAULT_STATE.sidebarWidth);
        setSidebarFilter(DEFAULT_STATE.sidebarFilter);
        setSidebarOpen(!DEFAULT_STATE.sidebarCollapsed);
      }
      setIsInitialized(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist.
  useEffect(() => {
    if (!isInitialized) return;
    const state: DocumentListState = {
      sortBy,
      sortDirection,
      folders,
      collapsedFolders: [],
      showHint,
      viewMode,
      iconSize,
      sidebarWidth,
      sidebarFilter,
      sidebarCollapsed: !sidebarOpen,
    };
    cachedDocumentListState = state;
    void saveDocumentListState(state);
  }, [
    sortBy,
    sortDirection,
    folders,
    showHint,
    viewMode,
    iconSize,
    sidebarWidth,
    sidebarFilter,
    sidebarOpen,
    isInitialized,
  ]);

  // Mobile drawer should never auto-open from persisted desktop state.
  useEffect(() => {
    if (!isNarrow) return;
    setMobileSidebarOpen(false);
  }, [isNarrow]);

  // Build the union document list.
  const rawDocuments: DocumentListDocument[] = useMemo(
    () => [
      ...pdfDocs.map((d) => ({ ...d, type: 'pdf' as const })),
      ...epubDocs.map((d) => ({ ...d, type: 'epub' as const })),
      ...htmlDocs.map((d) => ({ ...d, type: 'html' as const })),
    ],
    [pdfDocs, epubDocs, htmlDocs],
  );
  const rawDocumentIdsKey = useMemo(
    () => rawDocuments.map((d) => documentIdentityKey(d)).sort().join('|'),
    [rawDocuments],
  );
  const recentlyOpenedById = useLiveQuery<Record<string, number>, Record<string, number>>(
    async () => {
      try {
        return await getDocumentRecentlyOpenedMap();
      } catch (err) {
        console.warn('Failed to load recently opened cache metadata:', err);
        return {};
      }
    },
    [rawDocumentIdsKey],
    {},
  );

  const allDocuments: DocumentListDocument[] = useMemo(
    () =>
      rawDocuments.map((doc) => ({
        ...doc,
        recentlyOpenedAt: recentlyOpenedById[documentIdentityKey(doc)] ?? 0,
      })),
    [rawDocuments, recentlyOpenedById],
  );

  const allDocumentsById = useMemo(() => {
    const map = new Map<string, DocumentListDocument>();
    for (const doc of allDocuments) map.set(documentIdentityKey(doc), doc);
    return map;
  }, [allDocuments]);

  const foldersWithLiveDocs = useMemo(
    () =>
      folders.map((folder) => ({
        ...folder,
        documents: folder.documents
          .map((d) => allDocumentsById.get(documentIdentityKey(d)))
          .filter((d): d is DocumentListDocument => Boolean(d))
          .map((d) => ({ ...d, folderId: folder.id })),
      })),
    [folders, allDocumentsById],
  );

  const folderNameById = useMemo(
    () =>
      foldersWithLiveDocs.reduce<Record<string, string>>((acc, folder) => {
        acc[folder.id] = folder.name;
        return acc;
      }, {}),
    [foldersWithLiveDocs],
  );

  const folderIdByDocId = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of foldersWithLiveDocs) {
      for (const doc of folder.documents) map.set(documentIdentityKey(doc), folder.id);
    }
    return map;
  }, [foldersWithLiveDocs]);

  const allDocumentsWithFolder = useMemo(
    () =>
      allDocuments.map((doc) => ({
        ...doc,
        folderId: folderIdByDocId.get(documentIdentityKey(doc)),
      })),
    [allDocuments, folderIdByDocId],
  );

  // Filter based on sidebar selection + search query.
  const visibleDocuments = useMemo(() => {
    const q = query.trim().toLowerCase();
    let docs = allDocumentsWithFolder;
    if (sidebarFilter === 'pdf') docs = docs.filter((d) => d.type === 'pdf');
    else if (sidebarFilter === 'epub') docs = docs.filter((d) => d.type === 'epub');
    else if (sidebarFilter === 'html') docs = docs.filter((d) => d.type === 'html');
    else if (sidebarFilter === 'recents') {
      docs = [...docs]
        .filter((d) => (d.recentlyOpenedAt ?? 0) > 0)
        .sort((a, b) => (b.recentlyOpenedAt ?? 0) - (a.recentlyOpenedAt ?? 0))
        .slice(0, 20);
    } else if (sidebarFilter === 'audiobooks') {
      const ids = generatedAudiobookIds || [];
      docs = docs.filter((d) => ids.includes(d.id));
    } else if (sidebarFilter.startsWith('folder:')) {
      const fid = sidebarFilter.slice('folder:'.length);
      const folder = foldersWithLiveDocs.find((f) => f.id === fid);
      docs = folder
        ? folder.documents
            .map((d) => allDocumentsById.get(documentIdentityKey(d)))
            .filter((d): d is DocumentListDocument => Boolean(d))
            .map((d) => ({ ...d, folderId: fid }))
        : [];
    }
    if (q) docs = docs.filter((d) => d.name.toLowerCase().includes(q));
    return docs;
  }, [allDocumentsWithFolder, sidebarFilter, query, foldersWithLiveDocs, allDocumentsById, generatedAudiobookIds]);

  // Apply sort.
  const sortedVisible = useMemo(() => {
    if (sidebarFilter === 'recents') return visibleDocuments;
    return sortDocs(visibleDocuments, sortBy, sortDirection);
  }, [visibleDocuments, sidebarFilter, sortBy, sortDirection]);

  const counts = useMemo(
    () => ({
      all: allDocuments.length,
      pdf: pdfDocs.length,
      epub: epubDocs.length,
      html: htmlDocs.length,
    }),
    [allDocuments.length, pdfDocs.length, epubDocs.length, htmlDocs.length],
  );

  // --- Actions ---

  const { mutate } = useSWRConfig();

  const handleDelete = useCallback(async () => {
    if (!documentToDelete) return;
    try {
      if (documentToDelete.isAudiobookView) {
        const res = await fetch(`/api/audiobook?bookId=${encodeURIComponent(documentToDelete.id)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error('Failed to delete audiobook');
        await mutate('/api/audiobooks');
      } else {
        await deleteDocument(documentToDelete.id);
        setFolders((prev) =>
          prev.map((f) => ({
            ...f,
            documents: f.documents.filter(
              (d) => !(d.id === documentToDelete.id && d.type === documentToDelete.type),
            ),
          })),
        );
      }
      setDocumentToDelete(null);
    } catch (err) {
      console.error('Failed to remove document or audiobook:', err);
    }
  }, [deleteDocument, documentToDelete, mutate]);

  const handleDeleteDoc = useCallback((doc: DocumentListDocument) => {
    setDocumentToDelete({ id: doc.id, name: doc.name, type: doc.type, isAudiobookView: sidebarFilter === 'audiobooks' });
  }, [sidebarFilter]);

  const handleScanDoc = useCallback((doc: DocumentListDocument) => {
    setDocToScan(doc);
  }, []);

  const handleDramaCharacterScan = useCallback(async (doc: DocumentListDocument) => {
    if (isOpeningDramaCharacterScan) return;
    setIsOpeningDramaCharacterScan(true);
    try {
      const response = await fetch('/api/tts-settings', { cache: 'no-store' });
      const body = await response.json().catch(() => ({})) as {
        smartAudioProfiles?: SmartAudioProfile[];
        selectedSmartAudioProfileId?: string;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Could not load Audio Drama scanner settings.');

      const profiles = Array.isArray(body.smartAudioProfiles) ? body.smartAudioProfiles : [];
      const selectedDramaProfile = profiles.find((profile) => (
        profile.id === body.selectedSmartAudioProfileId
        && (profile.workerMode === 'multi-voice' || profile.workerMode === 'drama-gemini-tts')
      ));
      const dramaProfile = selectedDramaProfile
        || profiles.find((profile) => profile.workerMode === 'multi-voice' || profile.workerMode === 'drama-gemini-tts');
      if (!dramaProfile) {
        toast.error('Create an Audio Drama profile before scanning a drama cast. Regular LitRPG profiles do not scan characters.');
        window.dispatchEvent(new CustomEvent('open-smart-ai-profiles'));
        return;
      }
      if (!dramaProfile.geminiApiKeyConfigured) {
        toast.error('Add a Gemini API key to the Audio Drama profile before starting its character scan.');
        window.dispatchEvent(new CustomEvent('open-smart-ai-profiles'));
        return;
      }
      setDramaCharacterScan({ document: doc, profileId: dramaProfile.id, workerMode: dramaProfile.workerMode as 'multi-voice' | 'drama-gemini-tts' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open the Audio Drama character scanner.');
    } finally {
      setIsOpeningDramaCharacterScan(false);
    }
  }, [isOpeningDramaCharacterScan]);

  const [pendingDramaReplacementDoc, setPendingDramaReplacementDoc] = useState<{
    doc: DocumentListDocument;
    profileId: string;
    isCloud: boolean;
    savedMap: SmartAudioCharacterMap;
  } | null>(null);

  const handleStartDramaGeneration = useCallback(async (
    doc: DocumentListDocument,
    profileId: string,
    isCloud: boolean,
    savedMap: SmartAudioCharacterMap,
    confirmReplace = false,
  ) => {
    const toastId = toast.loading(`Queueing ${isCloud ? 'Google Cloud Drama' : 'Audio Drama'} for ${doc.name}…`);
    try {
      const narratorVoice = getNarratorVoiceId(savedMap, isCloud ? { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET } : {})
        || (isCloud ? (CLOUD_TTS_FEMALE_VOICES[0] || 'en-US-Journey-F') : 'af_bella');
      const res = await fetch('/api/audiobooks/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: doc.id,
          settings: {
            voice: narratorVoice,
            format: 'm4b',
            providerRef: isCloud ? 'google-cloud' : '',
            providerType: isCloud ? 'google-cloud' : undefined,
            ttsModel: isCloud ? CLOUD_TTS_MODEL : undefined,
            useSmartAudio: true,
            smartAudioProfileId: profileId,
          },
          confirmReplaceExisting: confirmReplace,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.code === 'AUDIOBOOK_REPLACEMENT_REQUIRED') {
        toast.dismiss(toastId);
        setPendingDramaReplacementDoc({ doc, profileId, isCloud, savedMap });
        return;
      }
      if (!res.ok) throw new Error(body?.error || 'Failed to queue drama generation.');
      toast.success(`Started generating ${isCloud ? 'Google Cloud Drama' : 'Audio Drama'} for ${doc.name}!`, { id: toastId });
      window.dispatchEvent(new Event(AUDIOBOOK_QUOTA_UPDATED_EVENT));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to queue drama generation.', { id: toastId });
    }
  }, [router]);

  const handleInspectDoc = useCallback((doc: DocumentListDocument) => {
    setDocToInspect(doc);
  }, []);

  const handleBulkDeleteAudiobooks = useCallback(async () => {
    const selectedDocs = selection.getSelectedDocs();
    try {
      await Promise.all(selectedDocs.map(async (doc) => {
        const res = await fetch(`/api/audiobook?bookId=${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete audiobook');
      }));
      await mutate('/api/audiobooks');
      selection.clear();
      setBulkDeleteAudiobooksPrompt(false);
    } catch (err) {
      console.error('Failed to bulk delete audiobooks:', err);
    }
  }, [selection, mutate]);

  const handleDropOnFolder = useCallback(
    (folderId: string, item: DocumentDragItem) => {
      setFolders((prev) =>
        prev.map((f) => {
          if (f.id !== folderId) {
            // Remove the dropped docs from any other folder they were in.
            return {
              ...f,
              documents: f.documents.filter(
                (d) => !item.items.some((it) => it.id === d.id && it.type === d.type),
              ),
            };
          }
          const existingIdentities = new Set(f.documents.map((d) => documentIdentityKey(d)));
          const newDocs = item.docs
            .filter((d) => !existingIdentities.has(documentIdentityKey(d)))
            .map((d) => ({ ...d, folderId }));
          return { ...f, documents: [...f.documents, ...newDocs] };
        }),
      );
      setSidebarFilter(`folder:${folderId}`);
      selection.clear();
    },
    [selection],
  );

  const handleDownloadSelected = useCallback(() => {
    const selectedDocs = selection.getSelectedDocs();
    if (selectedDocs.length === 0) return;
    
    (async () => {
      const { downloadAudiobookWithBackgroundPolling } = await import('@/lib/client/api/audiobooks');
      let combinedCount = 0;
      const toastId = 'batch-download';
      toast.loading(`Preparing ${selectedDocs.length} audiobook${selectedDocs.length === 1 ? '' : 's'} for download...`, { id: toastId });
      for (const doc of selectedDocs) {
        try {
          await downloadAudiobookWithBackgroundPolling(doc.id, 'm4b', toast, toastId);
          combinedCount++;
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          console.error(`Failed to combine audiobook ${doc.name}:`, err);
        }
      }
      if (combinedCount === selectedDocs.length) {
        toast.success(`Started downloading ${combinedCount} audiobook${combinedCount === 1 ? '' : 's'}.`, { id: toastId });
      } else if (combinedCount > 0) {
        toast.error(`Started downloading ${combinedCount}/${selectedDocs.length} audiobooks. Some failed.`, { id: toastId });
      } else {
        toast.error(`Failed to prepare audiobooks for download.`, { id: toastId });
      }
    })();
  }, [selection]);

  const handleDownloadSelectedOriginals = useCallback(() => {
    const selectedDocs = selection.getSelectedDocs();
    selectedDocs.forEach((doc, i) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = `/api/documents/blob/get/fallback?id=${encodeURIComponent(doc.id)}&download=true`;
        a.download = doc.name || `${doc.id}.bin`;
        a.click();
      }, i * 500);
    });
  }, [selection]);

  const handleMergeIntoFolder = useCallback(
    (sources: DocumentListDocument[], target: DocumentListDocument) => {
      if (target.folderId) return;
      const targetKey = documentIdentityKey(target);
      const filtered = sources.filter((s) => documentIdentityKey(s) !== targetKey && !s.folderId);
      if (filtered.length === 0) return;
      setPendingMerge({ sources: filtered, target });
      setNewFolderName('');
    },
    [],
  );

  const createFolderFromPending = useCallback(() => {
    if (!pendingMerge) return;
    const name =
      newFolderName.trim() ||
      generateDefaultFolderName(pendingMerge.sources[0], pendingMerge.target);
    const folderId = `folder-${Date.now()}`;
    setFolders((prev) => [
      ...prev,
      {
        id: folderId,
        name,
        documents: [
          ...pendingMerge.sources.map((d) => ({ ...d, folderId })),
          { ...pendingMerge.target, folderId },
        ],
      },
    ]);
    setPendingMerge(null);
    setNewFolderName('');
    setShowHint(false);
    setSidebarFilter(`folder:${folderId}`);
    selection.clear();
  }, [pendingMerge, newFolderName, selection]);

  const createManualFolder = useCallback(() => {
    const name = newFolderName.trim() || `New Folder`;
    const folderId = `folder-${Date.now()}`;
    setFolders((prev) => [...prev, { id: folderId, name, documents: [] }]);
    setNewFolderName('');
    setManualFolderPrompt(false);
    setSidebarFilter(`folder:${folderId}`);
  }, [newFolderName]);

  const handleDeleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    if (sidebarFilter === `folder:${folderId}`) setSidebarFilter('all');
  }, [sidebarFilter]);

  const previousSidebarFilter = useRef(sidebarFilter);
  useEffect(() => {
    if (sidebarFilter === 'audiobooks' && previousSidebarFilter.current !== 'audiobooks') {
      if (viewMode === 'icons') {
        setViewMode('list');
      }
    }
    previousSidebarFilter.current = sidebarFilter;
  }, [sidebarFilter, viewMode]);

  const handleClearFolders = useCallback(() => {
    setFolders([]);
    if (sidebarFilter.startsWith('folder:')) setSidebarFilter('all');
    setClearFoldersPrompt(false);
    selection.clear();
  }, [selection, sidebarFilter]);

  // Status bar summary.
  const summary = useMemo(() => {
    const parts: string[] = [];
    if (counts.pdf) parts.push(`${counts.pdf} PDF${counts.pdf === 1 ? '' : 's'}`);
    if (counts.epub) parts.push(`${counts.epub} EPUB${counts.epub === 1 ? '' : 's'}`);
    if (counts.html) parts.push(`${counts.html} Text${counts.html === 1 ? ' Doc' : ' Docs'}`);
    return parts.join(' • ');
  }, [counts]);

  const totalBytes = useMemo(
    () => allDocuments.reduce((acc, d) => acc + d.size, 0),
    [allDocuments],
  );
  const visibleSelectedCount = useMemo(
    () => sortedVisible.reduce((count, doc) => count + (selection.isSelected(doc) ? 1 : 0), 0),
    [sortedVisible, selection],
  );

  const isLoading = isPDFLoading || isEPUBLoading || isHTMLLoading;

  const handleUploadBatchChange = useCallback((state: UploadBatchState) => {
    setActiveUploadBatches((prev) => {
      if (!state.isActive) {
        if (!prev[state.uploaderId]) return prev;
        const next = { ...prev };
        delete next[state.uploaderId];
        return next;
      }
      return { ...prev, [state.uploaderId]: state };
    });
  }, []);

  const sidebarUploadState = useMemo(() => {
    const batches = Object.values(activeUploadBatches);
    if (batches.length === 0) return null;
    const totalFiles = batches.reduce((sum, batch) => sum + batch.totalFiles, 0);
    const completedFiles = batches.reduce((sum, batch) => sum + batch.completedFiles, 0);
    const currentFileName = batches.find((batch) => batch.currentFileName)?.currentFileName ?? null;
    return { totalFiles, completedFiles, phase: 'uploading' as const, currentFileName };
  }, [activeUploadBatches]);

  const fallbackViewMode: ViewMode = viewMode;
  const effectiveSidebarOpen = isNarrow ? mobileSidebarOpen : sidebarOpen;

  return (
    <FinderWindow
      toolbar={
        <FinderToolbar
          viewMode={fallbackViewMode}
          onViewModeChange={setViewMode}
          iconSize={iconSize}
          onIconSizeChange={setIconSize}
          sortBy={sortBy}
          sortDirection={sortDirection}
          onSortByChange={setSortBy}
          onSortDirectionToggle={() =>
            setSortDirection((p) => (p === 'asc' ? 'desc' : 'asc'))
          }
          query={query}
          onQueryChange={setQuery}
          onToggleSidebar={() =>
            isNarrow
              ? setMobileSidebarOpen((p) => !p)
              : setSidebarOpen((p) => !p)
          }
          isSidebarOpen={effectiveSidebarOpen}
          showSortControls={sidebarFilter !== 'recents'}
          leftSlot={brand}
        />
      }
      sidebar={
        <FinderSidebar
          filter={sidebarFilter}
          onFilterChange={setSidebarFilter}
          folders={foldersWithLiveDocs}
          counts={counts}
          onDeleteFolder={handleDeleteFolder}
          onNewFolder={() => {
            setNewFolderName('');
            setManualFolderPrompt(true);
          }}
          onClearFolders={() => setClearFoldersPrompt(true)}
          onDropOnFolder={handleDropOnFolder}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          topSlot={(
            <DocumentUploader
              variant="compact"
              onUploadBatchChange={handleUploadBatchChange}
              onClick={() => setIsUploadDialogOpen(true)}
            />
          )}
          bottomSlot={(
            <div className="flex flex-col gap-2">
              <AudiobookQuotaCard />
              {sidebarUploadState && (
                <SidebarUploadLoader
                  totalFiles={sidebarUploadState.totalFiles}
                  completedFiles={sidebarUploadState.completedFiles}
                  phase={sidebarUploadState.phase}
                  currentFileName={sidebarUploadState.currentFileName}
                />
              )}
              {appActions}
            </div>
          )}
          onRowAction={() => {
            if (isNarrow) setMobileSidebarOpen(false);
          }}
        />
      }
      statusBar={
        <FinderStatusBar
          itemCount={allDocuments.length}
          selectedCount={visibleSelectedCount}
          totalSize={totalBytes}
          summary={summary}
          actions={
            visibleSelectedCount > 0 && sidebarFilter === 'audiobooks' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBulkDeleteAudiobooksPrompt(true)}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-sm rounded-md shadow transition-all flex items-center gap-1.5"
                >
                  🗑️ Delete Audiobook{visibleSelectedCount > 1 ? 's' : ''}
                </button>
              </div>
            ) : sidebarFilter !== 'audiobooks' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const selected = selection.getSelectedDocs();
                    if (selected.length > 0) {
                      setDocToScan(selected[0]);
                    } else {
                      // Open selection modal prompt if no doc selected
                      if (allDocuments.length > 0) {
                        setSelectionModalProps({
                          title: 'Select Document to Pre-Scan',
                          confirmLabel: 'Pre-Scan Selected',
                          defaultSelected: false,
                          onConfirmAction: (docs) => {
                            if (docs.length > 0) setDocToScan(docs[0]);
                          },
                        });
                        setIsActionSelectionModalOpen(true);
                      } else {
                        toast('Please upload a document first.', { icon: 'ℹ️' });
                      }
                    }
                  }}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-md shadow transition-all flex items-center gap-1.5"
                >
                  🔍 Pre-Scan Foreign Words
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const selected = selection.getSelectedDocs();
                    if (selected.length > 0) {
                      void handleDramaCharacterScan(selected[0]);
                    } else if (allDocuments.length > 0) {
                      setSelectionModalProps({
                        title: 'Select Audio Drama to Pre-Scan',
                        confirmLabel: 'Open Character Scanner',
                        defaultSelected: false,
                        onConfirmAction: (docs) => {
                          if (docs.length > 0) void handleDramaCharacterScan(docs[0]);
                        },
                      });
                      setIsActionSelectionModalOpen(true);
                    } else {
                      toast('Please upload a document first.', { icon: 'ℹ️' });
                    }
                  }}
                  disabled={isOpeningDramaCharacterScan}
                  className="px-3 py-1.5 bg-accent hover:bg-secondary-accent disabled:opacity-60 text-background font-bold text-xs rounded-md shadow transition-colors flex items-center gap-1.5"
                  title="Only Audio Drama generation needs a character cast"
                >
                  🎭 {isOpeningDramaCharacterScan ? 'Opening Scanner…' : 'Pre-Scan Drama Characters'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const selected = selection.getSelectedDocs();
                    if (selected.length > 0) {
                      router.push(`/listen/${selected[0].id}`);
                    } else {
                      if (allDocuments.length > 0) {
                        setSelectionModalProps({
                          title: 'Select Document to Review',
                          confirmLabel: 'Review Audiobook',
                          defaultSelected: false,
                          onConfirmAction: (docs) => {
                            if (docs.length > 0) router.push(`/listen/${docs[0].id}`);
                          },
                        });
                        setIsActionSelectionModalOpen(true);
                      } else {
                        toast('Please upload a document first.', { icon: 'ℹ️' });
                      }
                    }
                  }}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-md shadow transition-all flex items-center gap-1.5"
                >
                  <PDFIcon className="w-4 h-4 text-white" />
                  Review Audiobook
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const selected = selection.getSelectedDocs();
                    if (selected.length > 0) {
                      handleDownloadSelectedOriginals();
                    } else {
                      if (allDocuments.length > 0) {
                        setSelectionModalProps({
                          title: 'Select Documents to Download',
                          confirmLabel: 'Download Selected',
                          defaultSelected: false,
                          onConfirmAction: (docs) => {
                            selection.replace(docs);
                            setTimeout(() => handleDownloadSelectedOriginals(), 50);
                          },
                        });
                        setIsActionSelectionModalOpen(true);
                      } else {
                        toast('Please upload a document first.', { icon: 'ℹ️' });
                      }
                    }
                  }}
                  className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100 font-bold text-xs rounded-md shadow transition-all"
                >
                  Download {visibleSelectedCount > 1 ? `${visibleSelectedCount} ` : ''}Originals
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const selected = selection.getSelectedDocs();
                    if (selected.length > 0) {
                      setShowBatchAudiobookSidebar(true);
                    } else {
                      if (allDocuments.length > 0) {
                        setSelectionModalProps({
                          title: 'Select Documents for Audiobook Generation',
                          confirmLabel: 'Proceed to Audiobook Setup',
                          defaultSelected: false,
                          onConfirmAction: (docs) => {
                            selection.replace(docs);
                            setShowBatchAudiobookSidebar(true);
                          },
                        });
                        setIsActionSelectionModalOpen(true);
                      } else {
                        toast('Please upload a document first.', { icon: 'ℹ️' });
                      }
                    }
                  }}
                  className="px-3 py-1.5 bg-accent hover:bg-secondary-accent text-background font-bold text-xs rounded-md shadow transition-all"
                >
                  Generate Audiobook{visibleSelectedCount > 1 ? 's' : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Trigger Settings modal directly to the API Keys section
                    const settingsBtn = document.querySelector('[aria-label="Settings"]') as HTMLButtonElement | null;
                    if (settingsBtn) settingsBtn.click();
                  }}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-md shadow transition-all flex items-center gap-1"
                >
                  🔑 API & Integrations
                </button>
              </div>
            ) : null
          }
        />
      }

      sidebarOpen={effectiveSidebarOpen}
      onRequestSidebarClose={() => {
        if (isNarrow) setMobileSidebarOpen(false);
      }}
    >
      {!isLoading && backgroundJobs && backgroundJobs.length > 0 && (
        <div className="px-3 pt-3 shrink-0 bg-surface-sunken">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-surface border border-accent rounded-md px-3 py-2 text-[13px] shadow-sm">
            <p className="text-foreground font-medium flex items-center gap-2">
              <svg className="w-4 h-4 text-accent animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              You have {backgroundJobs.length} audiobook{backgroundJobs.length > 1 ? 's' : ''} generating in the background.
            </p>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Button size="xs" variant="secondary" onClick={() => setSidebarFilter('jobs')}>View Queue</Button>
            </div>
          </div>
        </div>
      )}

      {!isLoading && showHint && allDocuments.length > 1 && (
        <div className="px-3 pt-3 shrink-0 bg-surface-sunken">
          <div className="flex items-center justify-between bg-surface border border-line rounded-md px-3 py-1 text-[12px]">
            <p className="text-foreground">
              Drag files onto each other to make folders. Drop into the sidebar to move.
            </p>
            <IconButton
              onClick={() => setShowHint(false)}
              size="xs"
              className="h-6 w-6"
              aria-label="Dismiss hint"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </IconButton>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          {isInitialized ? (
            <DocumentListSkeleton viewMode={fallbackViewMode} iconSize={iconSize} />
          ) : (
            <DocumentListStateLoader />
          )}
        </div>
      ) : sidebarFilter === 'jobs' ? (
        <JobsInlineView />
      ) : allDocuments.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <DocumentUploader
            className="py-12 w-full max-w-2xl"
            onUploadBatchChange={handleUploadBatchChange}
          />
        </div>
      ) : (
        <DocumentUploader
          variant="overlay"
          className="flex-1 min-h-0 flex flex-col"
          onUploadBatchChange={handleUploadBatchChange}
        >
          {fallbackViewMode === 'icons' && (
            <IconsView
              documents={sortedVisible}
              iconSize={iconSize}
              onDeleteDoc={handleDeleteDoc}
              onScanDoc={handleScanDoc}
              onInspectDoc={handleInspectDoc}
              onMergeIntoFolder={handleMergeIntoFolder}
              onExportToAbs={setAbsExportDoc}
              isAudiobookView={sidebarFilter === 'audiobooks'}
            />
          )}
          {fallbackViewMode === 'list' && (
            <ListView
              documents={sortedVisible}
              sortBy={sortBy}
              sortDirection={sortDirection}
              onSortChange={(b, d) => {
                setSortBy(b);
                setSortDirection(d);
              }}
              onDeleteDoc={handleDeleteDoc}
              onScanDoc={handleScanDoc}
              onInspectDoc={handleInspectDoc}
              onMergeIntoFolder={handleMergeIntoFolder}
              onExportToAbs={setAbsExportDoc}
              isAudiobookView={sidebarFilter === 'audiobooks'}
            />
          )}
          {fallbackViewMode === 'gallery' && (
            <GalleryView
              documents={sortedVisible}
              folderNameById={folderNameById}
              onDeleteDoc={handleDeleteDoc}
              onScanDoc={handleScanDoc}
              onInspectDoc={handleInspectDoc}
              onMergeIntoFolder={handleMergeIntoFolder}
              onExportToAbs={setAbsExportDoc}
              isAudiobookView={sidebarFilter === 'audiobooks'}
            />
          )}
        </DocumentUploader>
      )}

      {/* Audiobookshelf export modal — opened from any card/row's 📚 button */}
      {absExportDoc && (
        <AudiobookshelfModal
          open={true}
          onClose={() => setAbsExportDoc(null)}
          bookId={absExportDoc.id}
          initialTitle={absExportDoc.name.replace(/\.[^/.]+$/, '')}
          documentType={absExportDoc.type}
        />
      )}

      <CreateFolderDialog
        isOpen={pendingMerge !== null}
        onClose={() => setPendingMerge(null)}
        folderName={newFolderName}
        onFolderNameChange={setNewFolderName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createFolderFromPending();
          } else if (e.key === 'Escape') {
            setPendingMerge(null);
            setNewFolderName('');
          }
        }}
      />

      <CreateFolderDialog
        isOpen={manualFolderPrompt}
        onClose={() => setManualFolderPrompt(false)}
        folderName={newFolderName}
        onFolderNameChange={setNewFolderName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            createManualFolder();
          } else if (e.key === 'Escape') {
            setManualFolderPrompt(false);
            setNewFolderName('');
          }
        }}
      />

      {docToScan && (
        <ScanForeignWordsModal
          isOpen={true}
          onClose={() => setDocToScan(null)}
          documentId={docToScan.id}
          documentName={docToScan.name}
        />
      )}

      {dramaCharacterScan && (
        <MultiVoiceCharacterModal
          documentId={dramaCharacterScan.document.id}
          profileId={dramaCharacterScan.profileId}
          workerMode={dramaCharacterScan.workerMode}
          isOpen={true}
          standalone
          onClose={() => setDramaCharacterScan(null)}
          onComplete={async (savedCharacterMap, startGeneration) => {
            const doc = dramaCharacterScan.document;
            const profileId = dramaCharacterScan.profileId;
            const isCloud = dramaCharacterScan.workerMode === 'drama-gemini-tts';
            setDramaCharacterScan(null);
            if (startGeneration) {
              await handleStartDramaGeneration(doc, profileId, isCloud, savedCharacterMap);
            } else {
              toast.success(`Saved the Audio Drama cast for ${doc.name}.`);
            }
          }}
        />
      )}

      <ConfirmDialog
        isOpen={pendingDramaReplacementDoc !== null}
        onClose={() => setPendingDramaReplacementDoc(null)}
        onConfirm={async () => {
          if (!pendingDramaReplacementDoc) return;
          const { doc, profileId, isCloud, savedMap } = pendingDramaReplacementDoc;
          setPendingDramaReplacementDoc(null);
          await handleStartDramaGeneration(
            doc,
            profileId,
            isCloud,
            savedMap,
            true,
          );
        }}
        title="Replace Existing Audiobook?"
        message="This document already has a regular audiobook. Converting to Audio Drama will permanently delete every existing generated chapter and combined audiobook file for this book, then regenerate them with the reviewed narrator and character voices."
        confirmText="Replace & Regenerate"
        cancelText="Keep Existing Audiobook"
        isDangerous={true}
      />

      {docToInspect && (
        <BookPronunciationInspectorModal
          isOpen={true}
          onClose={() => setDocToInspect(null)}
          initialBookId={docToInspect.id}
        />
      )}

      <ConfirmDialog
        isOpen={documentToDelete !== null}
        onClose={() => setDocumentToDelete(null)}
        onConfirm={handleDelete}
        title={documentToDelete?.isAudiobookView ? 'Delete Audiobook' : 'Delete Document'}
        message={documentToDelete?.isAudiobookView ? `Are you sure you want to delete the audiobook for ${documentToDelete?.name.replace(/\.[^/.]+$/, "")}? The original document will not be deleted.` : `Are you sure you want to delete ${documentToDelete?.name ?? 'this document'}?`}
        confirmText="Delete"
        isDangerous
      />

      <ConfirmDialog
        isOpen={clearFoldersPrompt}
        onClose={() => setClearFoldersPrompt(false)}
        onConfirm={handleClearFolders}
        title="Remove All Folders"
        message="Remove all folders? This will not delete documents."
        confirmText="Remove Folders"
        isDangerous
      />

      <ConfirmDialog
        isOpen={bulkDeleteAudiobooksPrompt}
        onClose={() => setBulkDeleteAudiobooksPrompt(false)}
        onConfirm={handleBulkDeleteAudiobooks}
        title="Delete Selected Audiobooks"
        message={`Are you sure you want to delete the ${visibleSelectedCount} selected audiobooks? The original documents will not be deleted.`}
        confirmText="Delete"
        isDangerous
      />

      <BatchAudiobookSidebar
        isOpen={showBatchAudiobookSidebar}
        setIsOpen={setShowBatchAudiobookSidebar}
        selectedDocs={selection.getSelectedDocs()}
      />

      <UploadMenuDialog
        isOpen={isUploadDialogOpen}
        onClose={() => setIsUploadDialogOpen(false)}
        onUploadBatchChange={handleUploadBatchChange}
      />

      <DocumentSelectionModal
        isOpen={isActionSelectionModalOpen}
        onClose={() => setIsActionSelectionModalOpen(false)}
        onConfirm={(docs) => {
          setIsActionSelectionModalOpen(false);
          selectionModalProps.onConfirmAction(docs as DocumentListDocument[]);
        }}
        title={selectionModalProps.title}
        confirmLabel={selectionModalProps.confirmLabel}
        isProcessing={false}
        defaultSelected={selectionModalProps.defaultSelected}
        files={allDocuments}
      />
    </FinderWindow>
  );
}

export function DocumentList({
  brand,
  appActions,
}: {
  brand?: ReactNode;
  appActions?: ReactNode;
} = {}) {
  return (
    <DocumentDndProvider>
      <DocumentSelectionProvider>
        <DocumentListInner brand={brand} appActions={appActions} />
      </DocumentSelectionProvider>
    </DocumentDndProvider>
  );
}
