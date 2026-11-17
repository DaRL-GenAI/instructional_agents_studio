import { clearActiveSource } from './active-document-source';
import { clearDocumentSession } from './history/autosave';
import { beginDocumentOpen, commitDocumentOpen, isMountedDocumentOpen } from './document-open';
import { getDocmentObj, setDocmentObj } from '@ranuts/shared/store';
import { handleDocumentOperation, loadEditorApi } from './converter';
import { openDocumentFromUrl } from './document';
import { getReadonlyMode, requestSaveDocument, setReadonlyMode } from './onlyoffice-editor';
import { captureSavePoint, commitSavePoint } from './onlyoffice/save-point';
import { setEmbedExportListener } from './onlyoffice/save-stream';
import { getEditorContext } from './agent-plugin/editor-bridge';
import { hasUnsavedChanges, markDocumentSaved, onUnsavedChangesChange } from './unsaved-guard';

type EmbedMessageType =
  | 'document:open'
  | 'document:open-url'
  | 'document:open-file'
  | 'document:open-buffer'
  | 'document:set-readonly'
  | 'document:save'
  | 'document:run-macro'
  | 'document:get-state';

type EmbedMessage = {
  id?: string;
  type?: EmbedMessageType;
  payload?: Record<string, any>;
};

type EmbedResponsePayload = Record<string, any>;

const EMBED_QUERY_KEYS = ['embed', 'embedded'];

let initialized = false;
let parentOrigin = '*';
let acceptedParentOrigin: string | null = null;
let isEmbedMode = false;

function getQueryValue(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

function detectEmbedMode(): boolean {
  if (window.parent !== window) {
    return true;
  }

  return EMBED_QUERY_KEYS.some((key) => {
    const value = getQueryValue(key);
    return value === '' || value === '1' || value === 'true';
  });
}

function normalizeTargetOrigin(origin: string): string {
  return origin && origin !== 'null' ? origin : '*';
}

function shouldAcceptMessage(event: MessageEvent): boolean {
  if (event.source !== window.parent) return false;
  const allowedOrigin = getQueryValue('embedOrigin');
  if (allowedOrigin && event.origin !== allowedOrigin) return false;
  return acceptedParentOrigin === null || event.origin === acceptedParentOrigin;
}

function postToParent(type: string, payload: EmbedResponsePayload = {}, id?: string): void {
  if (!isEmbedMode) {
    return;
  }

  window.parent.postMessage(
    {
      id,
      type,
      payload,
    },
    parentOrigin,
  );
}

// Some hosts (e.g. a Qt WebEngine app driving the page via
// QWebEngineView.page().runJavaScript()) can only inject JSON-serializable
// literals -- there is no way to hand over a real ArrayBuffer from the host
// language. Base64-encoding the file content is the standard workaround, so
// accept a base64 string alongside the binary forms below. Strips an optional
// data-URL prefix ("data:...;base64,") for convenience.
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const commaIndex = base64.indexOf(',');
  const raw = base64.startsWith('data:') && commaIndex !== -1 ? base64.slice(commaIndex + 1) : base64;
  const binaryString = atob(raw);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function makeFileFromPayload(payload: Record<string, any>): File {
  const fileName = payload.fileName || payload.name || 'document.xlsx';

  if (payload.file instanceof File) {
    return payload.file;
  }

  if (payload.blob instanceof Blob) {
    return new File([payload.blob], fileName, {
      type: payload.blob.type || payload.mimeType || 'application/octet-stream',
    });
  }

  const buffer = payload.buffer || payload.arrayBuffer || payload.bytes || payload.data || payload.base64;
  if (buffer instanceof ArrayBuffer) {
    return new File([buffer], fileName, {
      type: payload.mimeType || 'application/octet-stream',
    });
  }

  if (buffer instanceof Uint8Array) {
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    return new File([arrayBuffer], fileName, {
      type: payload.mimeType || 'application/octet-stream',
    });
  }

  if (typeof buffer === 'string') {
    const bytes = decodeBase64ToUint8Array(buffer);
    return new File([bytes.buffer as ArrayBuffer], fileName, {
      type: payload.mimeType || 'application/octet-stream',
    });
  }

  throw new Error('document:open requires url, file, blob, buffer, arrayBuffer, bytes, data, or base64');
}

async function openFile(file: File, readonly = false): Promise<void> {
  const opening = beginDocumentOpen();
  await loadEditorApi();
  opening.assertCurrent();
  await handleDocumentOperation({
    fileName: file.name,
    file,
    isNew: false,
    readonly,
    signal: opening.signal,
    isCurrent: opening.isCurrent,
  });
  if (!commitDocumentOpen(opening.id)) throw new DOMException('Document open superseded', 'AbortError');
  setDocmentObj({ fileName: file.name, file });
  clearDocumentSession();
  await clearActiveSource();
  if (!isMountedDocumentOpen(opening.id)) throw new DOMException('Document open superseded', 'AbortError');
}

async function handleOpen(payload: Record<string, any>): Promise<void> {
  const readonly = Boolean(payload.readonly);

  if (payload.url) {
    await openDocumentFromUrl(String(payload.url), payload.fileName, {
      readonly,
      fetchOptions: payload.fetchOptions,
    });
    return;
  }

  await openFile(makeFileFromPayload(payload), readonly);
}

async function handleMessage(event: MessageEvent): Promise<void> {
  const message = event.data as EmbedMessage;
  if (
    !message ||
    typeof message !== 'object' ||
    typeof message.type !== 'string' ||
    !message.type.startsWith('document:')
  ) {
    return;
  }

  if (!shouldAcceptMessage(event)) {
    return;
  }

  acceptedParentOrigin ??= event.origin;
  parentOrigin = normalizeTargetOrigin(acceptedParentOrigin);
  const payload = message.payload || {};

  try {
    switch (message.type) {
      case 'document:open':
      case 'document:open-url':
      case 'document:open-file':
      case 'document:open-buffer':
        await handleOpen(payload);
        postToParent('document:opened', { readonly: getReadonlyMode() }, message.id);
        break;

      case 'document:set-readonly':
        setReadonlyMode(Boolean(payload.readonly));
        postToParent('document:readonly-changed', { readonly: getReadonlyMode() }, message.id);
        break;

      case 'document:save': {
        // Default to the open document's own format: a bare document:save on
        // a docx/pptx used to ask x2t for XLSX, which fails (code 88) and
        // only surfaced as a save timeout.
        // Legacy binary formats (and HTML-as-xls, opened as XLSX) cannot be
        // written back by x2t; their natural target is the OOXML sibling.
        const currentExt = (getDocmentObj()?.fileName || '').split('.').pop()?.toUpperCase() || '';
        const LEGACY_TARGET: Record<string, string> = { XLS: 'XLSX', DOC: 'DOCX', PPT: 'PPTX' };
        const defaultExt = LEGACY_TARGET[currentExt] || currentExt || 'XLSX';
        const returnOriginalOnTimeout = Boolean(payload.returnOriginalOnTimeout);
        // Taken before the export starts: edits made while it runs are not in
        // the bytes the host receives, so they must keep the document dirty.
        const savePoint = captureSavePoint();
        const file = await requestSaveDocument(String(payload.targetExt || defaultExt).toUpperCase(), {
          returnOriginalOnTimeout,
        });
        // The host now holds the edited bytes. A timeout fallback may have
        // handed it the original file instead, which saves nothing -- the
        // request cannot tell the two apart, so that mode never clears the flag.
        const targetExt = String(payload.targetExt || defaultExt).toUpperCase();
        const regularSave = targetExt === currentExt || targetExt === LEGACY_TARGET[currentExt];
        // An export to another format (PDF frames, images) saves nothing editable.
        if (regularSave && !returnOriginalOnTimeout && commitSavePoint(savePoint)) {
          markDocumentSaved();
        }
        postToParent(
          'document:saved',
          {
            file,
            fileName: file.name,
            mimeType: file.type,
            size: file.size,
            dirty: hasUnsavedChanges(),
          },
          message.id,
        );
        break;
      }

      case 'document:run-macro': {
        const result = await runMacro(payload);
        postToParent('document:macro-result', { result, dirty: hasUnsavedChanges() }, message.id);
        break;
      }

      case 'document:get-state':
        postToParent(
          'document:state',
          { readonly: getReadonlyMode(), hasDocument: Boolean(window.editor), dirty: hasUnsavedChanges() },
          message.id,
        );
        break;

      default:
        break;
    }
  } catch (error) {
    postToParent(
      'document:error',
      {
        message: error instanceof Error ? error.message : String(error),
      },
      message.id,
    );
  }
}

/**
 * Run Document Builder code (`payload.code`, a function body receiving `Api` and
 * `args`) inside the editor frame as one undoable step (`payload.readonly`: a
 * query, run outside history so it never dirties the document). Only for hosts pinned
 * with ?embedOrigin=: the code runs with this origin's privileges.
 */
async function runMacro(payload: Record<string, any>): Promise<unknown> {
  if (!getQueryValue('embedOrigin')) throw new Error('document:run-macro requires ?embedOrigin=');
  const query = Boolean(payload.readonly);
  if (!query && getReadonlyMode()) throw new Error('Document is read-only');
  if (typeof payload.code !== 'string' || !payload.code.trim()) throw new Error('document:run-macro requires code');
  const context = getEditorContext();
  const frame = document.querySelector<HTMLIFrameElement>('iframe[name="frameEditor"]')?.contentWindow as
    | (Window & { Function: FunctionConstructor; AscBuilder?: Record<string, { Api?: unknown }> })
    | null;
  const api = context?.api as Record<string, any> | undefined;
  if (!context || !frame) throw new Error('No editor is mounted');
  if (!api?.isDocumentLoadComplete) throw new Error('Editor is still loading');
  const builder = context.presentationBuilder ?? frame.AscBuilder?.Word?.Api ?? frame.AscBuilder?.Cell?.Api;
  if (!builder) throw new Error('Document Builder API is unavailable');
  const history = query ? undefined : (context.AscCommon?.History as Record<string, any> | undefined);
  const logic = api.WordControl?.m_oLogicDocument;
  // Compiled in the frame's realm so Builder objects and errors match its globals.
  const fn = new frame.Function('Api', 'args', payload.code);
  history?.startGroupPoints?.();
  try {
    let result = fn(builder, payload.args ?? null);
    if (result && typeof result.then === 'function') result = await result;
    if (!query) {
      history?.endGroupPoints?.();
      logic?.Recalculate?.({ Drawings: { All: true, Map: {} } });
      logic?.Document_UpdateInterfaceState?.();
    }
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  } catch (error) {
    if (!query) {
      history?.cancelGroupPoints?.();
      logic?.Recalculate?.({ Drawings: { All: true, Map: {} } });
    }
    throw error;
  }
}

export function initEmbedApi(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  isEmbedMode = detectEmbedMode();
  acceptedParentOrigin = getQueryValue('embedOrigin');
  if (acceptedParentOrigin) parentOrigin = normalizeTargetOrigin(acceptedParentOrigin);

  if (!isEmbedMode) {
    return;
  }

  document.body.classList.add('embed-mode');
  // Pushed, not polled: the host needs it to decide when to save (a tab
  // switch, an idle timer) without exporting documents nobody touched.
  setEmbedExportListener((file, regularSave) => {
    postToParent('document:exported', {
      file,
      fileName: file.name,
      mimeType: file.type,
      size: file.size,
      regularSave,
      dirty: hasUnsavedChanges(),
    });
  });
  onUnsavedChangesChange((dirty) => {
    postToParent('document:dirty-changed', { dirty });
  });
  window.addEventListener('message', (event) => {
    void handleMessage(event);
  });

  window.addEventListener('load', () => {
    postToParent('document:ready');
  });
}
