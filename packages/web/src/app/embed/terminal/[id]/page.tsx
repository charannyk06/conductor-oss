import { IframeTerminalPage } from "@/components/sessions/IframeTerminalPage";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bridgeId?: string }>;
};

export default async function EmbeddedTerminalPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { bridgeId } = await searchParams;

  return <IframeTerminalPage sessionId={id} bridgeId={bridgeId ?? null} />;
}
