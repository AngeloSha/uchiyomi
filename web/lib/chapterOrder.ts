// The series page's chapter order (#408, @julieminer): Oldest or Newest first, one choice for every series. Stored on the
// account (`app_settings.data.chapterOrder`, PUT /api/settings), like the Library's sort, so it follows the reader to every
// device they sign in on. The series page reads it on its first paint (the shell waits for the account), so a series never
// opens in the other order for a moment. Oldest first unless the account chose Newest, as every series opened before.

export type ChapterOrder = 'oldest' | 'newest';

/** Whether the account's chapter lists run oldest first. Anything but 'newest' reads as oldest. */
export function chapterOrderAsc(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.chapterOrder !== 'newest';
}
