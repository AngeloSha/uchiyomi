import { api } from './api';

export interface CleanupPage { number: number; name: string; bytes: number; gif: boolean; removed: boolean; restorable: boolean }
export interface PageCleanupPreview { revision: string; contentVersion: string; pages: CleanupPage[]; retainedBytes: number; unusedRetainedBytes: number; unusedRetainedImages: number }
export interface PageRulePreview {
  sourceId: string | null; sourceName?: string; seriesId?: string;
  pages: Array<{ number: number; name: string; rescued?: boolean }>;
  sourceRule: boolean | null; seriesRule: boolean | null; chapters: number; seriesChapters: number;
}
export type CleanupAction = 'remove' | 'restore' | 'purge' | 'purge-unused';
export type RuleScope = 'series' | 'source';

/** Only the selected slots in the preview may be submitted; a chapter always keeps a readable page. */
export function cleanupSelection(preview: PageCleanupPreview, action: CleanupAction, selected: ReadonlySet<number>): number[] {
  if (action === 'purge-unused') {
    if (selected.size || !preview.unusedRetainedImages) throw new Error('invalid_selection');
    return [];
  }
  const pages = preview.pages.filter((p) => selected.has(p.number) && (action === 'remove' ? !p.removed : p.removed && p.restorable)).map((p) => p.number);
  if (!pages.length || pages.length > 500) throw new Error('invalid_selection');
  if (action === 'remove' && pages.length >= preview.pages.filter((p) => !p.removed).length) throw new Error('all_pages');
  return pages;
}
export const cleanupPath = (bookId: string) => `/api/admin/books/${encodeURIComponent(bookId)}/page-cleanup`;
export const pageRulesPath = (bookId: string) => `/api/admin/books/${encodeURIComponent(bookId)}/page-rules`;
export const previewCleanup = (bookId: string) => api<PageCleanupPreview>(cleanupPath(bookId));
export const previewPageRules = (bookId: string) => api<PageRulePreview>(pageRulesPath(bookId));
export function savePageCleanup(bookId: string, preview: PageCleanupPreview, action: CleanupAction, selected: ReadonlySet<number>) {
  return api<PageCleanupPreview>(cleanupPath(bookId), {
    json: { action, pages: cleanupSelection(preview, action, selected), revision: preview.revision, confirm: true },
  });
}
export function savePageRule(bookId: string, scope: RuleScope, skipGif: boolean | null) {
  return api<{ ok: true }>(pageRulesPath(bookId), { method: 'PUT', json: { scope, skipGif, confirm: true } });
}
