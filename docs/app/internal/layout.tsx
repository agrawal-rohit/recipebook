import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { artefactsSource } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <DocsLayout tree={artefactsSource.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
