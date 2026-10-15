// "Plan to read when I add a series" (v0.68.0, #223), the web's half. The switch is the account's -- app_settings
// `trackerPlanOnAdd`, acted on by the server at every add (bff lib/trackers.ts planSeriesOnAdd) -- so this only says it.
import { keys } from './i18n';

/** Its name and what it does, on Profile → Connections → Progress tracking. */
export const PLAN_ON_ADD_TEXT = keys(
  'Plan to read when I add a series',
  'A series you add to the library goes on your trackers as Plan to read, where it is not on your list yet. Nothing already on your list changes, and nothing is sent while Incognito reading is on.',
);

/** Whether the account asked for it, as its settings say. Anything but `true` is off. */
export const planOnAddOf = (settings: Record<string, unknown> | null | undefined): boolean => settings?.trackerPlanOnAdd === true;
