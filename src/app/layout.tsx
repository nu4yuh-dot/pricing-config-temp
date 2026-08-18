import type { Metadata } from 'next';
import { IBM_Plex_Sans, IBM_Plex_Mono, IBM_Plex_Serif } from 'next/font/google';
import './globals.css';

/**
 * IBM Plex throughout: it is an engineering typeface with real character, and its
 * mono cut has the tabular figures a rate matrix needs. Serif carries the headings
 * so the pages read like a tariff document rather than a generic dashboard.
 */
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const serif = IBM_Plex_Serif({
  subsets: ['latin'],
  weight: ['600'],
  variable: '--font-plex-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'DNS Logistics — Pricing Configuration',
  description: 'Rate card configuration with admin approval.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`}>
      <body
        style={{
          // Bind the loaded fonts to the design system's variables.
          ['--font-sans' as string]: `var(--font-plex-sans), ui-sans-serif, sans-serif`,
          ['--font-mono' as string]: `var(--font-plex-mono), ui-monospace, monospace`,
          ['--font-serif' as string]: `var(--font-plex-serif), ui-serif, serif`,
        }}
      >
        {children}
      </body>
    </html>
  );
}
