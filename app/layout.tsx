import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BCC Rentals — Bachman Community Center",
  description: "Reserve a tent, popcorn machine, or party room at the Bachman Community Center.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
            <a href="/" className="text-lg font-semibold">
              BCC Rentals
            </a>
            <a
              href="https://bachmancc.org"
              className="text-sm text-muted-foreground hover:text-foreground"
              target="_blank"
              rel="noreferrer"
            >
              bachmancc.org
            </a>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mt-16 border-t">
          <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-muted-foreground">
            Bachman Community Center · Walden, TN ·{" "}
            <a href="mailto:reservations@bachmancc.org" className="hover:text-foreground">
              reservations@bachmancc.org
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
