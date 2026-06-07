import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import MobileTopBar from "@/components/MobileTopBar";

export const metadata: Metadata = {
  title: "Scout",
  description: "Scout — your Chief of Staff.",
  applicationName: "Scout",
  manifest: "/manifest.webmanifest",
  // Launch full-screen (no Safari chrome) when added to the iOS Home Screen.
  appleWebApp: {
    capable: true,
    title: "Scout",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#fafaf8",
  viewportFit: "cover", // enables env(safe-area-inset-*) so the input clears the home bar
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="flex flex-col md:flex-row h-[100dvh] overflow-hidden">
          <MobileTopBar />
          <Nav />
          {/* Scrollable for backstage pages; the chat page manages its own height. */}
          <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
