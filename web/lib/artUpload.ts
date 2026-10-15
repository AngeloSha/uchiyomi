// A picture an admin uploads as a series' cover or banner: the one limit and the one reader, for Edit details → Art
// (components/SeriesEditor.tsx) and the cover picker (components/CoverPickerSheet.tsx, #242), which had a copy of each.

/**
 * The largest picture an upload takes. ⚠️ The route's body limit is sized from it (bff routes/admin.ts ART_BODY_LIMIT):
 * the picture travels base64 in JSON, a third larger, and the 12 MB limit it had refused everything between 9 and
 * 11 MB that this dialog had just said it would take.
 */
export const ART_MAX_MB = 11;
export const ART_MAX_BYTES = ART_MAX_MB * 1024 * 1024;

/** A file as the data: URL the art route takes. */
export const dataUrlOf = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result));
  r.onerror = () => rej(new Error('read'));
  r.readAsDataURL(f);
});
