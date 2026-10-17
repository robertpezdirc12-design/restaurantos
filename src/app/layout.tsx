import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "RestaurantOS — restavracijski POS",
  description:
    "Restavracijski POS: blagajna, naročila, mize, kuhinja, plačilne povezave, zaloga, HACCP.",
  icons: {
    icon: "/pwa-icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "RestaurantOS" },
};

export const viewport: Viewport = {
  themeColor: "#047857",
  width: "device-width",
  initialScale: 1,
  // Naloga #11 (WCAG 1.4.4): maximumScale:1 je onemogočalo pinč-povečavo na
  // POS in čitalniku — številke na zaslonu so majhne, uporabniki s slabšim
  // vidom pa so bili ujeti. Povečava je vedno dovoljena; namenski kiosk
  // terminal svojo omejitev nastavi v lastnem brskalniku, ne prek meta.
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
