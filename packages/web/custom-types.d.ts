// This file mirrors the route type declarations generated in `.next/dev/types/routes.d.ts`.

type AppRoutes = "/" | "/sessions/[id]" | "/sign-in/[[...sign-in]]"
type AppRouteHandlerRoutes = "/api/agents" | "/api/config" | "/api/events" | "/api/health/boards" | "/api/sessions" | "/api/sessions/[id]" | "/api/sessions/[id]/checks" | "/api/sessions/[id]/diff" | "/api/sessions/[id]/feedback" | "/api/sessions/[id]/keys" | "/api/sessions/[id]/kill" | "/api/sessions/[id]/output" | "/api/sessions/[id]/restore" | "/api/sessions/[id]/send" | "/api/spawn"
type PageRoutes = never
type LayoutRoutes = "/"
type RedirectRoutes = never
type RewriteRoutes = never
type Routes = AppRoutes | PageRoutes | LayoutRoutes | RedirectRoutes | RewriteRoutes


interface ParamMap {
  "/": {}
  "/api/agents": {}
  "/api/config": {}
  "/api/events": {}
  "/api/health/boards": {}
  "/api/sessions": {}
  "/api/sessions/[id]": { "id": string; }
  "/api/sessions/[id]/checks": { "id": string; }
  "/api/sessions/[id]/diff": { "id": string; }
  "/api/sessions/[id]/feedback": { "id": string; }
  "/api/sessions/[id]/keys": { "id": string; }
  "/api/sessions/[id]/kill": { "id": string; }
  "/api/sessions/[id]/output": { "id": string; }
  "/api/sessions/[id]/restore": { "id": string; }
  "/api/sessions/[id]/send": { "id": string; }
  "/api/spawn": {}
  "/sessions/[id]": { "id": string; }
  "/sign-in/[[...sign-in]]": { "sign-in"?: string[]; }
}


export type ParamsOf<Route extends Routes> = ParamMap[Route]

interface LayoutSlotMap {
  "/": never
}


export type { AppRoutes, PageRoutes, LayoutRoutes, RedirectRoutes, RewriteRoutes, ParamMap, AppRouteHandlerRoutes }

declare global {
  /**
   * Props for Next.js App Router page components
   * @example
   * ```tsx
   * export default function Page(props: PageProps<'/blog/[slug]'>) {
   *   const { slug } = await props.params
   *   return <div>Blog post: {slug}</div>
   * }
   * ```
   */
  interface PageProps<AppRoute extends AppRoutes> {
    params: Promise<ParamMap[AppRoute]>
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }

  /**
   * Props for Next.js App Router layout components
   * @example
   * ```tsx
   * export default function Layout(props: LayoutProps<'/dashboard'>) {
   *   return <div>{props.children}</div>
   * }
   * ```
   */
  type LayoutProps<LayoutRoute extends LayoutRoutes> = {
    params: Promise<ParamMap[LayoutRoute]>
    children: React.ReactNode
  } & {
    [K in LayoutSlotMap[LayoutRoute]]: React.ReactNode
  }

  /**
   * Context for Next.js App Router route handlers
   * @example
   * ```tsx
   * export async function GET(request: NextRequest, context: RouteContext<'/api/users/[id]'>) {
   *   const { id } = await context.params
   *   return Response.json({ id })
   * }
   * ```
   */
  interface RouteContext<AppRouteHandlerRoute extends AppRouteHandlerRoutes> {
    params: Promise<ParamMap[AppRouteHandlerRoute]>
  }
}
