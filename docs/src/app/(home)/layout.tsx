import { HomeLayout } from "fumadocs-ui/layouts/home";
import { Footer } from "@/components/footer";
import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/">) {
  const options = baseOptions();
  return (
    <HomeLayout {...options} nav={{ ...options.nav, transparentMode: "top" }}>
      {children}
      <Footer />
    </HomeLayout>
  );
}
