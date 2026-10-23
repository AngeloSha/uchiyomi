'use client';
// Admin -> Settings -> Server -> Home network (bff GET/PATCH /api/admin/network, lib/clientAddr.ts): where profiles
// without a password open, and which reverse proxies may say who is connecting. Like Sonarr's and Radarr's local
// addresses, the home is the private networks until it is written; unlike them, the page shows the address the server
// sees for every signed-in device, because a proxy or Docker that hides who is connecting makes everyone private -- and
// everyone at home. LOCAL_NETWORKS and TRUST_PROXY in the environment outrank the page: their rows show the value and
// say where to change it.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Disclosure, MoreOptions, Row, RowBlock, RowGroup, SegmentedRow, TextRow } from '@/components/settings';

type Source = 'env' | 'settings' | 'default';
export interface NetworkState {
  ip: string | null;
  zone: 'local' | 'remote';
  viaProxy: boolean;
  localNetworks: { value: string; source: Source };
  trustedProxies: { value: string; source: Source };
  defaults: { localNetworks: string; trustedProxies: string };
  /** The admin's own /24, when it is a private one: "Use my network". */
  suggestion: string | null;
  warnings: Array<
    | { code: 'trust_all' } | { code: 'via_cloudflare' } | { code: 'home_default_proxy' }
    | { code: 'proxy_at_home'; ip: string } | { code: 'proxy_unnamed'; ip: string }
  >;
  recent: Array<{ ip: string; lastSeen: string; name: string; zone: 'local' | 'remote' }>;
}

/** An address or a name inside a sentence, isolated so a right-to-left language does not reorder it. */
const iso = (s: string) => `⁨${s}⁩`;

/** One answer for Members' line and this page. */
export const useNetwork = () => useQuery({ queryKey: ['admin-network'], queryFn: () => api<NetworkState>('/api/admin/network') });

/** The address the server sees you at, and whether that is at home: one sentence. */
export function seenText(n: NetworkState): string {
  if (n.localNetworks.value === 'none') return tr('No network is home, so profiles without a password open only in the desktop app.');
  const ip = iso(n.ip ?? '?');
  return n.zone === 'local' ? tr('The server sees you at {ip}, at home.', { ip }) : tr('The server sees you at {ip}, outside your home network.', { ip });
}

export function NetworkSettings() {
  const qc = useQueryClient();
  const { data } = useNetwork();
  // "These networks" picked while nothing is saved yet: the field shows before there is a value to save.
  const [custom, setCustom] = useState(false);
  if (!data) return null;
  // The answer is the page's new state: no second round trip.
  const save = async (body: { localNetworks?: string | null; trustedProxies?: string | null }) => {
    qc.setQueryData(['admin-network'], await api<NetworkState>('/api/admin/network', { method: 'PATCH', json: body }));
  };
  const home = data.localNetworks;
  const proxies = data.trustedProxies;
  const mode = home.source !== 'default' && home.value === 'none' ? 'none' : home.source === 'settings' || custom ? 'custom' : 'private';
  const fromEnv = (name: string) => tr('Set by {name} in the environment: change it there.', { name: iso(name) });

  return (
    <RowGroup title={tr('Home network')}
      description={tr('Profiles without a password open only from the home network. From anywhere else, an account needs its password.')}>
      <Row label={tr('How the server sees you')} help={seenText(data)} />

      {home.source === 'env' ? (
        <Row id="local-networks" label={tr('Home network')} help={fromEnv('LOCAL_NETWORKS')}>
          <code dir="ltr" className="text-xs text-fog-300">{home.value}</code>
        </Row>
      ) : (
        <>
          <SegmentedRow id="local-networks" label={tr('Home network')} value={mode}
            help={mode === 'private' ? tr('Every private address: 192.168.x, 10.x and 172.16–31.x, as a home router or Docker hands them out.') : undefined}
            options={[
              { value: 'private', label: tr('Private networks') },
              { value: 'custom', label: tr('These networks') },
              { value: 'none', label: tr('None') },
            ]}
            onChange={async (v) => {
              setCustom(v === 'custom');
              if (v === 'custom') { if (data.suggestion && home.source === 'default') await save({ localNetworks: data.suggestion }); return; }
              await save({ localNetworks: v === 'none' ? 'none' : null });
            }} />
          {mode === 'custom' && (
            <>
              <TextRow label={tr('Networks')} dir="ltr" autoComplete="off" maxLength={2000}
                help={tr('Addresses and ranges, separated by commas, e.g. 192.168.1.0/24.')}
                value={home.source === 'settings' ? home.value : ''} placeholder={data.suggestion ?? '192.168.1.0/24'}
                onSave={(v) => save({ localNetworks: v.trim() || null })} />
              {data.suggestion && home.value !== data.suggestion && (
                <RowBlock>
                  <button type="button" onClick={() => { void save({ localNetworks: data.suggestion }); }} className="btn-key" data-use-my-network>
                    {tr('Use {network}', { network: iso(data.suggestion) })}
                  </button>
                </RowBlock>
              )}
            </>
          )}
        </>
      )}

      {data.warnings.map((w) => (
        <RowBlock key={'ip' in w ? `${w.code}-${w.ip}` : w.code}>
          <p role="note" className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200" data-network-warning={w.code}>
            {w.code === 'trust_all'
              ? tr('Every peer is trusted as a proxy (TRUST_PROXY=true), so anyone can say any address: nobody counts as at home.')
              : w.code === 'via_cloudflare'
                ? tr('You reach the server through Cloudflare, where nobody counts as at home. At home, open it by its local address, or by a local DNS name that points at your proxy.')
                : w.code === 'home_default_proxy'
                ? tr('You reach the server through a proxy while home is still every private network: a tunnel or a container running at home looks like home too. Choose These networks above and write your own network, e.g. 192.168.1.0/24.')
                : w.code === 'proxy_unnamed'
                ? tr('You reach the server through the proxy {ip}, trusted only as part of a private network. Until its address is in Trusted proxies, nobody behind it counts as at home: a visitor could write their own address.', { ip: iso(w.ip) })
                : tr('The proxy {ip} is inside the home network: a request it forwards without X-Forwarded-For counts as at home.', { ip: iso(w.ip) })}
          </p>
          {/* The one proxy this page was reached through, written out: what the warning asks for, a tap away. */}
          {w.code === 'proxy_unnamed' && proxies.source !== 'env' && (
            <button type="button" onClick={() => { void save({ trustedProxies: w.ip }); }} className="btn-key mt-2" data-trust-proxy>
              {tr('Trust only {ip}', { ip: iso(w.ip) })}
            </button>
          )}
        </RowBlock>
      ))}

      {/* The proxies and the devices fold away: Server stays a page that reads at a glance (settingsIndex.test.ts). */}
      <MoreOptions id="network-more">
        {proxies.source === 'env' ? (
          <Row id="trusted-proxies" label={tr('Trusted proxies')} help={fromEnv('TRUST_PROXY')}>
            <code dir="ltr" className="text-xs text-fog-300">{proxies.value}</code>
          </Row>
        ) : (
          <TextRow id="trusted-proxies" label={tr('Trusted proxies')} dir="ltr" autoComplete="off" maxLength={2000}
            help={tr('The reverse proxies allowed to say who is connecting (X-Forwarded-For). Empty: this computer, Docker and the private networks.')}
            value={proxies.source === 'settings' ? proxies.value : ''} placeholder={data.defaults.trustedProxies}
            onSave={(v) => save({ trustedProxies: v.trim() || null })} />
        )}
        {data.recent.length > 0 && (
          <RowBlock>
            <Disclosure label={tr('Signed-in devices')}>
              <p className="max-w-prose text-[11px] leading-relaxed text-fog-500">
                {tr('The address the server sees for each, and whether that is at home. If a phone on mobile data reads at home, a proxy or Docker is hiding who is connecting: write your network above.')}
              </p>
              <ul className="mt-2 space-y-1 text-xs" data-network-devices>
                {data.recent.map((r) => (
                  <li key={r.ip} className="flex flex-wrap items-baseline gap-x-2 text-fog-300">
                    <span className="text-fog-100">{r.name}</span>
                    <code dir="ltr" className="text-fog-400">{r.ip}</code>
                    <span className={r.zone === 'local' ? 'text-emerald-300' : 'text-fog-500'}>{r.zone === 'local' ? tr('at home') : tr('outside')}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </RowBlock>
        )}
      </MoreOptions>
    </RowGroup>
  );
}
