import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Previo",
  description: "스타트업 개발팀을 위한 Previo DevSecOps 플랫폼",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
