import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { PwaStatus } from '@/components/pwa-status';

// Inter holds up at the small sizes an operations table needs and ships real
// tabular figures. JetBrains Mono is reserved for IDs (TXN-, HND-, PR-).
const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "AHL Purchase & Inventory",
    template: "%s · AHL Flow",
  },
  description:
    "Inventory, purchase requests and goods receipt for American Hair Line.",
  applicationName: "AHL Inventory",
  icons: { apple:'/icons/apple-touch-icon.png', icon:'/icons/icon-192.png' },
  appleWebApp: {
    capable: true,
    title: "AHL Flow",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  // Staff use this one-handed on a clinic floor; let them zoom a bill photo.
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background">
        <Providers><PwaStatus />{children}</Providers>
      </body>
    </html>
  );
}
