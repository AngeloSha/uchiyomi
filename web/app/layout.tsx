import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from './providers';
import { AppShell } from '@/components/AppShell';

// Self-hosted rather than next/font/google: that fetches from fonts.gstatic.com at BUILD time, so a blip
// there fails the image build outright -- which is how v0.5.1 shipped half-published, with the API image
// pushed and the web image not. These are the same latin-subset variable files Google serves; keeping them
// in the repo also means the image builds behind a firewall and with no third-party call.
const display = localFont({
  src: './fonts/SpaceGrotesk-latin.woff2',
  variable: '--font-display',
  display: 'swap',
  weight: '300 700',
});
const sans = localFont({
  src: './fonts/Inter-latin.woff2',
  variable: '--font-sans',
  display: 'swap',
  weight: '100 900',
});
const brand = localFont({
  src: './fonts/Unbounded-latin.woff2',
  variable: '--font-brand',
  display: 'swap',
  weight: '600 800',
});

export const metadata: Metadata = {
  title: 'Uchiyomi — your library, your way',
  description: 'A cinematic, personal reader for your manga & manhwa.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Uchiyomi' },
  icons: { icon: '/icons/favicon.png', apple: '/icons/apple-touch-icon.png' },
  openGraph: {
    title: 'Uchiyomi',
    description: 'A cinematic, personal reader for your manga & manhwa.',
    images: ['/art/og.jpg'],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'Uchiyomi', images: ['/art/og.jpg'] },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${brand.variable}`}>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
