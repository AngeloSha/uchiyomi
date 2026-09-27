// What Admin → Extensions says, step by step, when the extension engine is off, not set up or not answering
// (#72), with no React in it so the steps can be tested line by line (web/test/engineSetup.test.ts).
//
// Adding the engine is a different job on each platform -- a line in .env on Compose, a second template on
// Unraid, an imported add-on on CasaOS, nothing at all on Umbrel -- and until v0.49.0 the tab had one sentence
// for all of them, which told a Compose admin who had just set EXTENSION_ENGINE=0 to "put SUWAYOMI_URL back". So
// each platform gets its own steps, the page opens on the one the server guessed (bff lib/platform.ts), and the
// platform chips switch between them.
//
// ⚠️ Commands and names are never translated: a step's sentence is a key (declared below for the string
// extractor), and anything someone copies -- a command, a path, a variable -- is a literal, shown as code. A
// translated `docker compose up -d` is a command that does not run.
import { keys, t as tr } from './i18n';

export type Platform = 'compose' | 'unraid' | 'casaos' | 'umbrel' | 'other' | 'desktop';

/** The chips, in the order people are likely to be on them. The desktop app shows its own card (EngineInstall). */
export const PLATFORM_CHIPS: readonly Platform[] = ['compose', 'unraid', 'casaos', 'umbrel', 'other'];

/** Product names read the same in every language; only "Somewhere else" is a sentence to translate. */
export const PLATFORM_NAMES: Record<Exclude<Platform, 'other'>, string> = {
  compose: 'Docker Compose', unraid: 'Unraid', casaos: 'CasaOS', umbrel: 'Umbrel', desktop: 'Uchiyomi Desktop',
};
export const platformLabel = (p: Platform): string => (p === 'other' ? tr('Somewhere else') : PLATFORM_NAMES[p]);

/** What GET /api/admin/extensions/status answers (bff lib/extensionEngine.ts engineStatusReport). */
export interface EngineReport {
  configured: boolean;
  reachable: boolean;
  version?: string | null;
  error?: string;
  /** Why there is no engine to talk to: EXTENSION_ENGINE=0 on the bundled one, or no address at all. */
  off?: 'switch' | 'unset';
  platform?: string;
  /** Series added through an extension: what the engine's data is worth. */
  linkedSeries?: number;
  retry?: { attempts: number; since: string; nextAt: string } | null;
  lastTry?: string | null;
  engine?: string;
  solver?: {
    supported: boolean;
    enabled: boolean;
    wiring: 'ok' | 'off' | 'localhost' | 'other' | 'unsupported';
    connectable: boolean;
    url?: string;
  };
}

export type Headline = 'switched_off' | 'unset' | 'unreachable' | 'ready';

export function headline(s: Pick<EngineReport, 'configured' | 'reachable' | 'off'>): Headline {
  if (!s.configured) return s.off === 'switch' ? 'switched_off' : 'unset';
  return s.reachable ? 'ready' : 'unreachable';
}

/**
 * The platform the steps open on: the server's guess, or Compose when it has none -- an install on a compose
 * file older than v0.49.0 passes no clue, and that is the likeliest one to have none.
 */
export function defaultPlatform(s: Pick<EngineReport, 'platform'>): Platform {
  const p = s.platform as Platform | undefined;
  return p && (PLATFORM_CHIPS.includes(p) || p === 'desktop') ? p : 'compose';
}

/** The pinned engine. bff/test/enginePins.test.ts holds this equal to every other pin. */
export const ENGINE_IMAGE = 'ghcr.io/suwayomi/suwayomi-server:v2.3.2243';
const RAW = 'https://raw.githubusercontent.com/AngeloSha/uchiyomi/main';

/**
 * Every sentence a step can say. Declared through keys() because they reach tr() through the step objects,
 * which the string extractor cannot see (lib/i18n.ts); `StepText` then makes a step with an undeclared sentence a
 * type error, so the two cannot drift.
 */
export const STEP_TEXT = keys(
  // Compose
  'Open the .env file next to your docker-compose.yml and delete this line, or change its 0 to 1:',
  'Then start it. Its data was kept, so your extensions are where you left them:',
  'In the .env file next to your docker-compose.yml, if there is a {name} line with no value after the =, delete it.',
  'A docker-compose.yml from before v0.49.0 has no switch for it; download the current one next to your .env:',
  'Then start it:',
  'See whether the engine’s container is running:',
  'Start it, and anything else that has stopped:',
  'If it keeps stopping, its log says why:',
  'Add this line to the .env file next to your docker-compose.yml:',
  'Then apply it. The engine’s container goes away; its data stays in the {volume} volume:',
  // Unraid
  'In Unraid, open Apps, search for {name} and install it.',
  'Before its first start, create its folder from the Unraid terminal (the engine runs as user 1000):',
  'Then set {name} on the uchiyomi container to this address, with your server’s IP, and apply:',
  'On the Docker tab, start {name}. If it keeps stopping, its log says why.',
  'Check that {name} on the uchiyomi container is still this address, with your server’s IP:',
  'On the Docker tab, stop {name} (or remove it), then empty {setting} on the uchiyomi container and apply.',
  // CasaOS
  'In a terminal on the CasaOS machine, create the engine’s folder (it runs as user 1000):',
  'In CasaOS, choose Custom install, then Import, and import this file:',
  'Then set {name} in Uchiyomi’s settings in CasaOS to:',
  'In CasaOS, start the {name} app. If it keeps stopping, its log says why.',
  'Check that {name} in Uchiyomi’s settings in CasaOS is still:',
  'In CasaOS, stop the {name} app (or remove it), then empty {setting} in Uchiyomi’s settings.',
  // Umbrel
  'Not available on Umbrel: an Umbrel app can’t add an optional second container. MangaDex and sites you add by address work without it.',
  // Somewhere else
  'Run the engine where Uchiyomi can reach it, with its data in a volume that stays. These are the settings the shipped files use:',
  'The engine has no password of its own: anyone who can reach port {port} can install extensions on it and change its settings. Keep that port on a private network, never open to the internet.',
  'Then set {name} on Uchiyomi to the engine’s address and restart Uchiyomi:',
  'Check that the engine is running and that Uchiyomi can reach the address in {name}.',
  'Stop the engine, then empty {name} on Uchiyomi and restart Uchiyomi.',
  // Desktop
  'Uchiyomi Desktop downloads the engine itself, once, from this tab.',
  'The engine runs only while Uchiyomi is open. There is no switch for it: one that was never downloaded costs nothing.',
);
export type StepText = (typeof STEP_TEXT)[number];

/** One step: its sentence (a key), the literals its placeholders stand for, and a command to copy, if any. */
export interface Step {
  text: StepText;
  vars?: Record<string, string>;
  command?: string;
}

const ENGINE = 'uchiyomi-suwayomi';
const URL_VAR = 'SUWAYOMI_URL';
/**
 * The engine's volume on Compose, as `docker volume ls` shows it. Compose puts the project's name (the folder's,
 * by default) in front of every volume the file declares, so the file's `uchiyomi_suwayomi` is
 * `uchiyomi_uchiyomi_suwayomi` in a folder called uchiyomi -- and a command that names the bare
 * `uchiyomi_suwayomi` makes a new, EMPTY volume of that name without an error. The s11 review caught the docs'
 * backup recipe doing exactly that; the same `<project>_` form as docs/MIGRATING.md.
 */
const COMPOSE_VOLUME = '<project>_uchiyomi_suwayomi';
const UP = 'docker compose up -d';

/** How to bring the engine (back) on `p`, for the state the page is in. */
export function onSteps(p: Platform, h: Headline): Step[] {
  const down = h === 'unreachable';
  switch (p) {
    case 'compose':
      if (down) {
        return [
          { text: 'See whether the engine’s container is running:', command: `docker compose ps ${ENGINE}` },
          { text: 'Start it, and anything else that has stopped:', command: UP },
          { text: 'If it keeps stopping, its log says why:', command: `docker compose logs --tail 50 ${ENGINE}` },
        ];
      }
      if (h === 'switched_off') {
        return [
          { text: 'Open the .env file next to your docker-compose.yml and delete this line, or change its 0 to 1:', command: 'EXTENSION_ENGINE=0' },
          { text: 'Then start it. Its data was kept, so your extensions are where you left them:', command: UP },
        ];
      }
      return [
        // "With nothing after it" could mean after the = or after the line: it is the value that is empty.
        { text: 'In the .env file next to your docker-compose.yml, if there is a {name} line with no value after the =, delete it.', vars: { name: `${URL_VAR}=` } },
        { text: 'A docker-compose.yml from before v0.49.0 has no switch for it; download the current one next to your .env:', command: `curl -O ${RAW}/deploy/docker-compose.yml` },
        { text: 'Then start it:', command: UP },
      ];
    case 'unraid':
      if (down) {
        return [
          { text: 'On the Docker tab, start {name}. If it keeps stopping, its log says why.', vars: { name: ENGINE } },
          { text: 'Check that {name} on the uchiyomi container is still this address, with your server’s IP:', vars: { name: URL_VAR }, command: 'http://YOUR-SERVER-IP:4567' },
        ];
      }
      return [
        { text: 'In Unraid, open Apps, search for {name} and install it.', vars: { name: ENGINE } },
        { text: 'Before its first start, create its folder from the Unraid terminal (the engine runs as user 1000):', command: `mkdir -p /mnt/user/appdata/${ENGINE} && chown 1000:1000 /mnt/user/appdata/${ENGINE}` },
        { text: 'Then set {name} on the uchiyomi container to this address, with your server’s IP, and apply:', vars: { name: URL_VAR }, command: 'http://YOUR-SERVER-IP:4567' },
      ];
    case 'casaos':
      if (down) {
        return [
          { text: 'In CasaOS, start the {name} app. If it keeps stopping, its log says why.', vars: { name: ENGINE } },
          { text: 'Check that {name} in Uchiyomi’s settings in CasaOS is still:', vars: { name: URL_VAR }, command: `http://${ENGINE}:4567` },
        ];
      }
      return [
        { text: 'In a terminal on the CasaOS machine, create the engine’s folder (it runs as user 1000):', command: `sudo mkdir -p /DATA/AppData/${ENGINE} && sudo chown 1000:1000 /DATA/AppData/${ENGINE}` },
        { text: 'In CasaOS, choose Custom install, then Import, and import this file:', command: `${RAW}/deploy/casaos/${ENGINE}.yml` },
        { text: 'Then set {name} in Uchiyomi’s settings in CasaOS to:', vars: { name: URL_VAR }, command: `http://${ENGINE}:4567` },
      ];
    case 'umbrel':
      return [{ text: 'Not available on Umbrel: an Umbrel app can’t add an optional second container. MangaDex and sites you add by address work without it.' }];
    case 'desktop':
      return [{ text: 'Uchiyomi Desktop downloads the engine itself, once, from this tab.' }];
    case 'other':
      if (down) return [{ text: 'Check that the engine is running and that Uchiyomi can reach the address in {name}.', vars: { name: URL_VAR } }];
      return [
        {
          text: 'Run the engine where Uchiyomi can reach it, with its data in a volume that stays. These are the settings the shipped files use:',
          command: `docker run -d --name ${ENGINE} --restart unless-stopped --memory=1536m -p 4567:4567 `
            + `-v uchiyomi_suwayomi:/home/suwayomi/.local/share/Tachidesk -e JAVA_TOOL_OPTIONS="-Xmx768m -XX:+UseSerialGC" `
            + '-e AUTO_DOWNLOAD_CHAPTERS=false -e DOWNLOAD_AS_CBZ=true -e WEB_UI_ENABLED=false '
            + `-e FLARESOLVERR_ENABLED=true -e FLARESOLVERR_URL=http://YOUR-SOLVER:8191 ${ENGINE_IMAGE}`,
        },
        // ⚠️ The engine answers anyone who reaches its port, and installing an extension is running someone's code
        // inside it. The Compose file never publishes the port (it `expose`s it to Uchiyomi's network only); this
        // command has to, for a Uchiyomi elsewhere to reach it, so it says what that opens (the s11 review).
        { text: 'The engine has no password of its own: anyone who can reach port {port} can install extensions on it and change its settings. Keep that port on a private network, never open to the internet.', vars: { port: '4567' } },
        // The ENGINE's address: "its address" read as Uchiyomi's own.
        { text: 'Then set {name} on Uchiyomi to the engine’s address and restart Uchiyomi:', vars: { name: URL_VAR }, command: 'http://ENGINE-HOST:4567' },
      ];
  }
}

/** How to turn it off safely on `p`: always keeping its data. */
export function offSteps(p: Platform): Step[] {
  switch (p) {
    case 'compose':
      return [
        { text: 'Add this line to the .env file next to your docker-compose.yml:', command: 'EXTENSION_ENGINE=0' },
        { text: 'Then apply it. The engine’s container goes away; its data stays in the {volume} volume:', vars: { volume: COMPOSE_VOLUME }, command: UP },
      ];
    case 'unraid':
      return [{ text: 'On the Docker tab, stop {name} (or remove it), then empty {setting} on the uchiyomi container and apply.', vars: { name: ENGINE, setting: URL_VAR } }];
    case 'casaos':
      return [{ text: 'In CasaOS, stop the {name} app (or remove it), then empty {setting} in Uchiyomi’s settings.', vars: { name: ENGINE, setting: URL_VAR } }];
    case 'desktop':
      return [{ text: 'The engine runs only while Uchiyomi is open. There is no switch for it: one that was never downloaded costs nothing.' }];
    case 'umbrel':
    case 'other':
      return [{ text: 'Stop the engine, then empty {name} on Uchiyomi and restart Uchiyomi.', vars: { name: URL_VAR } }];
  }
}

/**
 * Where the engine's data lives on `p`, for the never-delete-it warning; null where there is none to warn about
 * (Umbrel cannot run it). The folders are the ones the Unraid template and the CasaOS add-on mount.
 */
export function dataPlace(p: Platform): string | null {
  switch (p) {
    case 'compose': return COMPOSE_VOLUME;
    case 'unraid': return `/mnt/user/appdata/${ENGINE}`;
    case 'casaos': return `/DATA/AppData/${ENGINE}`;
    case 'other': return '/home/suwayomi/.local/share/Tachidesk';
    case 'desktop': return 'engine';
    case 'umbrel': return null;
  }
}

/** The never-delete-it warning, counted: its data holds the only link to every series added through it. */
export function dataWarning(linked: number): string {
  if (linked === 1) return tr('Don’t delete the engine’s data ({place}): it keeps 1 series linked to its source, and Uchiyomi’s nightly backup doesn’t include it.');
  if (linked > 1) return tr('Don’t delete the engine’s data ({place}): it keeps {n} series linked to their source, and Uchiyomi’s nightly backup doesn’t include it.', { n: linked });
  return tr('Don’t delete the engine’s data ({place}): it holds your extensions and the link for every series you add through them, and Uchiyomi’s nightly backup doesn’t include it.');
}

/** The headline, in words. Never asked for `ready`: the panel is the catalogue then, with its own mark. */
export function headlineText(h: Headline): string {
  return h === 'switched_off' ? tr('Extensions are turned off')
    : h === 'unset' ? tr('No extension engine is set up for this server.')
    : h === 'unreachable' ? tr('The extension engine isn’t answering')
    : '';
}

/**
 * The line "Check again" leaves when the engine is still not there. It stays until the next press: the card
 * turning into the catalogue is the success, so there is never a success line to show.
 */
export function stillLine(s: EngineReport): string {
  const h = headline(s);
  // With no reason to give it says only that: "Still no answer: no reply" said it twice.
  if (h === 'unreachable') return s.error ? tr('Still no answer: {reason}', { reason: s.error }) : tr('Still no answer');
  // The switch and the address are read when Uchiyomi starts, and each platform's steps end in the command or
  // the Apply that restarts it -- so "still off" after the steps means the restart has not happened yet.
  return tr('Still off. Uchiyomi reads this setting when it starts; applying the change restarts it.');
}
