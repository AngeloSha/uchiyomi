'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t as tr } from '@/lib/i18n';
import { Section, SwitchRow } from '@/components/settings';

export interface ExternalReaderOptions {
  supported?:boolean;
  externalReadingStats:boolean;
  opdsEstimatedBookmarks:boolean;
  byReader?:Array<{origin:string;chapters:number}>;
}

export function ExternalReaderSettings(){
  const client=useQueryClient();
  const {data}=useQuery({queryKey:['external-readers'],queryFn:()=>api<ExternalReaderOptions>('/api/external-readers')});
  const save=async(key:'externalReadingStats'|'opdsEstimatedBookmarks',on:boolean)=>{
    const next=await api<ExternalReaderOptions>('/api/external-readers',{method:'PUT',json:{[key]:on}});
    client.setQueryData(['external-readers'],next);
    void client.invalidateQueries({queryKey:['stats-insights']});
  };
  if(data?.supported===false)return null;
  return <Section id="external-reader-progress" title={tr('External reader progress')}>
    <p className="mb-3 text-xs text-fog-400">{tr('KOReader: use this server’s URL followed by /api/v1/kosync. Choose Binary matching. Sign in with a read/write API token as the username and any dummy password. Create a separate token for each device below.')}</p>
    {data&&<>
      <SwitchRow label={tr('Count completed chapters from other apps')} on={data.externalReadingStats}
        help={tr('Count small new completions reported by Komga and KOReader in your history, Insights, heatmap and Wrapped. Initial links and bulk catch-ups stay silent. No reading time, streaks, badges or household rankings are inferred.')}
        onChange={on=>save('externalReadingStats',on)}/>
      <SwitchRow label={tr('Remember estimated OPDS positions')} on={data.opdsEstimatedBookmarks}
        help={tr('Use streamed page requests as estimated bookmarks in OPDS when no explicit position exists. Readers may prefetch pages. These estimates never mark chapters completed, create reading statistics or update trackers.')}
        onChange={on=>save('opdsEstimatedBookmarks',on)}/>
    </>}
    <p className="mt-3 text-xs text-fog-500">{tr('Incognito keeps your private position and suppresses reading events and tracker updates across all readers.')}</p>
  </Section>;
}
