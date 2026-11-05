'use client';
// Upload a series: a series no source carries, started from chapter files on this device. Its own page, beside the
// Library header's Import a list (/admin/import/), and for the same reason: a flow of its own, with room on a phone.
// Admins, and members an admin gave canUploadManually (POST /api/library/upload checks the same). `/upload/` -- the
// trailing slash is load-bearing, see next.config.mjs (`trailingSlash: true`, static export).
import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, canUploadManually } from '@/lib/auth';
import { UploadSeriesSection } from '@/components/ChapterUpload';
import { IcChevronLeft } from '@/components/icons';
import { t as tr } from '@/lib/i18n';

function UploadSeriesPage() {
  const router = useRouter();
  const { user, status } = useAuth();
  const seriesId = useSearchParams().get('seriesId') || '';
  const series = useQuery({ queryKey: ['upload-series', seriesId], enabled: !!seriesId && status === 'authed' && canUploadManually(user),
    queryFn: () => api<any>(`/api/series/${encodeURIComponent(seriesId)}`), retry: false });
  if (status === 'authed' && !canUploadManually(user)) {
    return <div className="flex min-h-screen-d items-center justify-center px-4 text-center text-fog-400">{tr('Your account is not allowed to upload series.')}</div>;
  }
  return (
    <div className="min-h-screen-d px-4 pb-10 pt-4 lg:px-0">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => router.push('/library/')} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-fog-400 hover:text-fog-100" aria-label={tr('Back')}>
          <IcChevronLeft width={18} height={18} className="rtl:rotate-180" />
        </button>
        <h1 className="min-w-0 truncate font-display text-lg font-semibold text-fog-50">{tr(seriesId ? 'Upload chapters' : 'Upload a series')}</h1>
      </div>
      <div className="card p-4">
        {seriesId ? (series.isPending ? <p>{tr('Loading…')}</p> : series.isError ? <p role="alert">{tr('Could not load series')}</p>
          : <UploadSeriesSection key={seriesId} seriesId={seriesId} seriesTitle={series.data?.metadata?.title || series.data?.name} />) : <UploadSeriesSection />}
      </div>
    </div>
  );
}

export default function UploadPage() { return <Suspense><UploadSeriesPage /></Suspense>; }
