import { Github, Package, BookOpen } from "lucide-react";

const links = [
  { label: "GitHub", href: "https://github.com/charannyk06/conductor-oss", icon: Github },
  { label: "npm", href: "https://www.npmjs.com/package/conductor-oss", icon: Package },
  { label: "Docs", href: "https://github.com/charannyk06/conductor-oss#readme", icon: BookOpen },
];

export function Footer() {
  return (
    <footer className="border-t border-zinc-800/60 bg-zinc-950/80 py-12">
      <div className="mx-auto max-w-6xl px-6">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <span
              className="text-lg font-bold tracking-tight text-zinc-200"
              style={{ fontFamily: "var(--font-jetbrains-mono), monospace" }}
            >
              conductor
            </span>
            <span className="rounded bg-violet-600/20 px-1.5 py-0.5 text-[10px] font-bold text-violet-400">
              OSS
            </span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-5">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition hover:text-zinc-300"
              >
                <link.icon className="h-4 w-4" />
                {link.label}
              </a>
            ))}
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center gap-2 text-center text-xs text-zinc-600 sm:flex-row sm:justify-between sm:text-left">
          <p>Built by the community. MIT Licensed.</p>
          <p>&copy; {new Date().getFullYear()} Conductor OSS Contributors</p>
        </div>
      </div>
    </footer>
  );
}
