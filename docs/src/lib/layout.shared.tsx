import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, docsRoute, githubURL } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <p className="font-medium tracking-tight text-lg lowercase">
          {appName}
        </p>
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
