import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, Inter, Unbounded } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { AppShell } from '@/components/AppShell';

const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const brand = Unbounded({ subsets: ['latin'], variable: '--font-brand', weight: ['600', '700', '800'], display: 'swap' });

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
