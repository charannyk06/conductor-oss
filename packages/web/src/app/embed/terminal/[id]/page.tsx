import { IframeTerminalPage } from "@/components/sessions/IframeTerminalPage";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bridgeId?: string | string[] }>;
};

export default async function EmbeddedTerminalPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { bridgeId } = await searchParams;
  const normalizedBridgeId = Array.isArray(bridgeId) ? bridgeId[0] : bridgeId;

  return <IframeTerminalPage sessionId={id} bridgeId={normalizedBridgeId ?? null} />;
}
