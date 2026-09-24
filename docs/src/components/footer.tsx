import { cn } from "cn";
import Link from "next/link";
import { appName, docsRoute, githubURL, licenseURL } from "@/lib/shared";

export interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

export interface FooterSection {
  title: string;
  links: FooterLink[];
}

export interface FooterLogo {
  title: string;
  description: string;
}

export interface Footer2Props {
  logo?: FooterLogo;
  sections?: FooterSection[];
  copyright?: string;
  className?: string;
}

const defaultLogo: FooterLogo = {
  title: appName.toLowerCase(),
  description:
    "Declarative framework for authoring and sharing artefacts from a registry you control.",
};

const defaultSections: FooterSection[] = [
  {
    title: "Resources",
    links: [
      { label: "Docs", href: docsRoute },
      { label: "Github", href: githubURL, external: true },
      { label: "License", href: licenseURL, external: true },
    ],
  },
];

function FooterLinkItem({ link }: Readonly<{ link: FooterLink }>) {
  const className =
    "text-muted-foreground text-sm no-underline transition-colors hover:text-foreground";

  if (link.external) {
    return (
      <a
        href={link.href}
        rel="noreferrer"
        target="_blank"
        className={className}
      >
        {link.label}
      </a>
    );
  }

  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}

export function Footer({
  logo = defaultLogo,
  sections = defaultSections,
  copyright = `© ${new Date().getFullYear()} ${appName.toLowerCase()}`,
  className,
}: Readonly<Footer2Props>) {
  return (
    <footer className={cn("border-t border-border", className)}>
      <div className="mx-auto w-full max-w-(--fd-layout-width) px-6 py-12">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="flex max-w-sm flex-col gap-1">
            <p className="font-medium text-lg lowercase tracking-tight">
              {logo.title}
            </p>
            <p className="text-muted-foreground text-sm text-pretty">
              {logo.description}
            </p>
          </div>
          <div className="flex flex-col gap-10 sm:flex-row sm:gap-0">
            {sections.map((section) => (
              <div
                key={section.title}
                className="flex min-w-0 flex-col gap-3 md:pr-32"
              >
                <p className="font-medium text-sm">{section.title}</p>
                <ul className="flex flex-col gap-2.5">
                  {section.links.map((link) => (
                    <li key={link.label}>
                      <FooterLinkItem link={link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-10 border-t border-border pt-8 text-center">
          <p className="text-muted-foreground text-sm">
            {copyright}
            <span aria-hidden="true"> · </span>
            <a
              href={licenseURL}
              rel="noreferrer"
              target="_blank"
              className="text-muted-foreground no-underline transition-colors hover:text-foreground"
            >
              MIT
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
