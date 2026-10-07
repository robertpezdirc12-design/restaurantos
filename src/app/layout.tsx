import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "RestavrantOS — restavracijski sistem (rekonstrukcija)",
  description:
    "Restavracijski POS: blagajna, naročila, mize, kuhinja. Rekonstrukcija 1.27.0 po forenzični analizi Vercel deploymenta.",
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
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
        </ThemeProvider>
      </body>
    </html>
  );
}
