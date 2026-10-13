import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "RestavrantOS — restavracijski sistem (rekonstrukcija)",
  description:
    "Restavracijski POS: blagajna, naročila, mize, kuhinja, plačilne povezave, zaloga, HACCP.",
  icons: {
    icon: "/pwa-icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "RestavrantOS" },
};

export const viewport: Viewport = {
  themeColor: "#047857",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="sl" suppressHydrationWarning>
      <body className="antialiased bg-stone-50 text-stone-900">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
          <PwaRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
