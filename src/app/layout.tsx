import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import MobileTopBar from "@/components/MobileTopBar";

export const metadata: Metadata = {
  title: "Scout",
  description: "Scout — your Chief of Staff.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
          <main className="flex-1 min-w-0 overflow-hidden">{children}</main>
        </div>
      </body>
    </html>
  );
}
