import type { Metadata } from "next";
import { ThemeProvider } from "@multica/ui/components/theme-provider";
import { Toaster } from "@multica/ui/components/ui/sonner";
import { AuthProvider } from "../lib/auth-context";
import { WSProvider } from "../lib/ws-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "Multica",
  description: "AI-native task management",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: ["/favicon.svg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthProvider>
            <WSProvider>{children}</WSProvider>
          </AuthProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
