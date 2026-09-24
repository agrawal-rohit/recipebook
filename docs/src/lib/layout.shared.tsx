import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";
import { appName, docsRoute, githubURL } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <div className="flex items-center gap-2">
          <Logo />
          <p className="font-medium tracking-tight text-lg lowercase">
            {appName}
          </p>
        </div>
      ),
    },
    links: [
      {
        text: "Docs",
        url: docsRoute,
        active: "nested-url",
      },
    ],
    githubUrl: githubURL,
  };
}
