// "Only tell me about my next chapter" (the account setting `notifyOnlyNext`, bff lib/nextUp.ts): on only for a real
// `true`, so a missing or malformed value is the default, off.
export function notifyOnlyNextOn(settings: Record<string, unknown> | null | undefined): boolean {
  return settings?.notifyOnlyNext === true;
}
