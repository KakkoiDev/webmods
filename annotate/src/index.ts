export { createAnnotator } from "./annotator";
export {
  createMemoryStorage,
  createLocalStorageStorage,
  createIndexedDBStorage,
  createTampermonkeyStorage,
  DocumentStorage,
  emptyDB,
  migrateDB,
} from "./storage";
export { createPortableDataPlugin, validateAnnotation, validateExportDocument } from "./plugins/portable-data";
export { createGlobalBrowserPlugin, searchAnnotations, noteLink } from "./plugins/global-browser";
export type { GlobalBrowserPlugin, GlobalSearchResult } from "./plugins/global-browser";
export { collectPages } from "./plugins/portable-data";
export type { PageGroup } from "./plugins/portable-data";
export { download, copyText } from "./dom-utils";
export { createChatPlugin, createEchoProvider } from "./plugins/chat";
export type {
  ChatProvider,
  ChatPlugin,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatScope,
  AnnotationChatContext,
} from "./plugins/chat";
export { createClaudeProvider } from "./providers/claude";
export type { ClaudeProviderOptions } from "./providers/claude";
export { createExcalidrawPlugin, isExcalidrawAttachment } from "./plugins/excalidraw";
export type { ExcalidrawAttachment, ExcalidrawScene, ExcalidrawPlugin, ExcalidrawLoader } from "./plugins/excalidraw";
export { createDefaultPageIdentityResolver, normalizeUrl, stripOwnFragment, hashString } from "./page-identity";
export { createDefaultBlockResolver, scoreBlock, buildExcludeFn } from "./blocks";
export { createAnchor, resolveAnchor, buildSelector, buildXPath, textSimilarity, normalizeText } from "./anchors";
export { createRangeAnchor, resolveRangeInBlock, blockTextWithMap, buildRange, rangeOffsets } from "./ranges";
export type { BlockTextMap } from "./ranges";
export { renderMarkdown } from "./markdown";
export { createCommandRegistry } from "./commands";
export { generateId } from "./events";
export * from "./types";

// Convenience aliases matching the spec's illustrative naming.
export { createMemoryStorage as memoryStorage } from "./storage";
export { createLocalStorageStorage as localStorageStorage } from "./storage";
export { createIndexedDBStorage as indexedDBStorage } from "./storage";
export { createTampermonkeyStorage as tampermonkeyStorage } from "./storage";
export { createAnnotator as create } from "./annotator";
