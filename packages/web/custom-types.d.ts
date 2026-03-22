// This file mirrors the route type declarations generated in `.next/types/routes.d.ts`.

declare module "next/dist/build/segment-config/app/app-segment-config.js" {
  export type PrefetchForTypeCheckInternal = InstantConfigForTypeCheckInternal;
}

type AppRoutes = "/" | "/sessions/[id]" | "/sign-in/[[...sign-in]]" | "/unlock"
type AppRouteHandlerRoutes =
  | "/api/access"
  | "/api/agents"
  | "/api/attachments"
  | "/api/boards"
  | "/api/config"
  | "/api/context-files"
  | "/api/context-files/open"
  | "/api/events"
  | "/api/executor/health"
  | "/api/filesystem/directory"
  | "/api/filesystem/pick-directory"
  | "/api/github/repos"
  | "/api/health/boards"
  | "/api/health/sessions"
  | "/api/notifications"
  | "/api/preferences"
  | "/api/repositories"
  | "/api/repositories/[id]"
  | "/api/sessions"
  | "/api/sessions/[id]"
  | "/api/sessions/[id]/actions"
  | "/api/sessions/[id]/archive"
  | "/api/sessions/[id]/checks"
  | "/api/sessions/[id]/diff"
  | "/api/sessions/[id]/feedback"
  | "/api/sessions/[id]/files"
  | "/api/sessions/[id]/feed"
  | "/api/sessions/[id]/interrupt"
  | "/api/sessions/[id]/keys"
  | "/api/sessions/[id]/kill"
  | "/api/sessions/[id]/output"
  | "/api/sessions/[id]/output/stream"
  | "/api/sessions/[id]/preview"
  | "/api/sessions/[id]/preview/dom"
  | "/api/sessions/[id]/preview/screenshot"
  | "/api/sessions/[id]/restore"
  | "/api/sessions/[id]/send"
  | "/api/spawn"
  | "/api/workspaces"
  | "/api/workspaces/branches"
type PageRoutes = never
type LayoutRoutes = "/"
type RedirectRoutes = never
type RewriteRoutes = never
type Routes = AppRoutes | PageRoutes | LayoutRoutes | RedirectRoutes | RewriteRoutes


interface ParamMap {
  "/": {}
  "/api/access": {}
  "/api/agents": {}
  "/api/attachments": {}
  "/api/boards": {}
  "/api/config": {}
  "/api/context-files": {}
  "/api/context-files/open": {}
  "/api/events": {}
  "/api/executor/health": {}
  "/api/filesystem/directory": {}
  "/api/filesystem/pick-directory": {}
  "/api/github/repos": {}
  "/api/health/boards": {}
  "/api/health/sessions": {}
  "/api/notifications": {}
  "/api/preferences": {}
  "/api/repositories": {}
  "/api/repositories/[id]": { "id": string; }
  "/api/sessions": {}
  "/api/sessions/[id]": { "id": string; }
  "/api/sessions/[id]/actions": { "id": string; }
  "/api/sessions/[id]/archive": { "id": string; }
  "/api/sessions/[id]/checks": { "id": string; }
  "/api/sessions/[id]/diff": { "id": string; }
  "/api/sessions/[id]/feedback": { "id": string; }
  "/api/sessions/[id]/files": { "id": string; }
  "/api/sessions/[id]/feed": { "id": string; }
  "/api/sessions/[id]/interrupt": { "id": string; }
  "/api/sessions/[id]/keys": { "id": string; }
  "/api/sessions/[id]/kill": { "id": string; }
  "/api/sessions/[id]/output": { "id": string; }
  "/api/sessions/[id]/output/stream": { "id": string; }
  "/api/sessions/[id]/preview": { "id": string; }
  "/api/sessions/[id]/preview/dom": { "id": string; }
  "/api/sessions/[id]/preview/screenshot": { "id": string; }
  "/api/sessions/[id]/restore": { "id": string; }
  "/api/sessions/[id]/send": { "id": string; }
  "/api/spawn": {}
  "/api/workspaces": {}
  "/api/workspaces/branches": {}
  "/sessions/[id]": { "id": string; }
  "/sign-in/[[...sign-in]]": { "sign-in"?: string[]; }
  "/unlock": {}
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
