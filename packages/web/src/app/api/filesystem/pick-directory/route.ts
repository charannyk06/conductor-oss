import { NextRequest, NextResponse } from "next/server";
import { exec } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { guardApiAccess } from "@/lib/auth";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

const DIALOG_TIMEOUT = 5 * 60 * 1000; // 5 minutes — user may take time to navigate

export async function POST(request: NextRequest) {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;

  const os = platform();

  try {
    let selectedPath = "";

    if (os === "darwin") {
      const { stdout } = await execAsync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select a folder")'`,
        { timeout: DIALOG_TIMEOUT },
      );
      selectedPath = stdout.trim();
    } else if (os === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
        '$dialog.Description = "Select a folder"',
        "$dialog.ShowNewFolderButton = $true",
        "$result = $dialog.ShowDialog()",
        "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
      ].join("; ");

      const encoded = Buffer.from(script, "utf16le").toString("base64");
      const { stdout } = await execAsync(
        `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
        { timeout: DIALOG_TIMEOUT },
      );
      selectedPath = stdout.trim();
    } else {
      // Linux — try zenity, fall back to kdialog
      try {
        const { stdout } = await execAsync(
          `zenity --file-selection --directory --title="Select a folder" 2>/dev/null`,
          { timeout: DIALOG_TIMEOUT },
        );
        selectedPath = stdout.trim();
      } catch {
        const { stdout } = await execAsync(
          `kdialog --getexistingdirectory ~ 2>/dev/null`,
          { timeout: DIALOG_TIMEOUT },
        );
        selectedPath = stdout.trim();
      }
    }

    if (!selectedPath) {
      return NextResponse.json({ cancelled: true });
    }

    // Remove trailing separator (keep root "/" or "C:\")
    if (selectedPath.length > 1 && (selectedPath.endsWith("/") || selectedPath.endsWith("\\"))) {
      selectedPath = selectedPath.slice(0, -1);
    }

    return NextResponse.json({ path: selectedPath });
  } catch (err: unknown) {
    // osascript exits non-zero when the user clicks Cancel
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("User canceled") || msg.includes("cancelled") || msg.includes("Cancel")) {
      return NextResponse.json({ cancelled: true });
    }
    return NextResponse.json(
      { error: msg || "Failed to open folder picker" },
      { status: 500 },
    );
  }
}
