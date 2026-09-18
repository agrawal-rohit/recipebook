import * as AccordionComponents from "fumadocs-ui/components/accordion";
import * as FilesComponents from "fumadocs-ui/components/files";
import * as TabsComponents from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import {
  Chip,
  ChipRow,
  EmptyHint,
  Eyebrow,
  FindingChip,
  Note,
  Panel,
  PhasePill,
} from "@/components/ui";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...AccordionComponents,
    ...FilesComponents,
    ...TabsComponents,
    TypeTable,
    Chip,
    ChipRow,
    EmptyHint,
    Eyebrow,
    FindingChip,
    Note,
    Panel,
    PhasePill,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
