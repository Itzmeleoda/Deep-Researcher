import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import {
  listProfiles,
  saveProfile,
  deleteProfile,
  hasProfile,
  getSearchConfigMasked,
  saveSearchConfig,
} from "./store/profileStore";
import { testConnection } from "./adapters";
import { runDeepResearch } from "./pipeline/runner";
import type { ResearchEvent } from "./adapters/types";

let win: BrowserWindow | null = null;
const runs = new Map<string, AbortController>();

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
    // win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

// ---- Profiles ----
ipcMain.handle("profiles:list", () => listProfiles());
ipcMain.handle("profiles:save", (_e, input: Record<string, unknown>) => saveProfile(input));
ipcMain.handle("profiles:delete", (_e, id: string) => {
  deleteProfile(String(id));
  return { ok: true };
});
ipcMain.handle("profiles:test", (_e, id: string) => testConnection(String(id)));

// ---- Search config ----
ipcMain.handle("search:get", () => getSearchConfigMasked());
ipcMain.handle("search:save", (_e, input: { provider: "tavily" | "serper"; apiKey?: string; baseUrlOverride?: string }) => {
  saveSearchConfig(input);
  return { ok: true };
});

// ---- Research run (streaming via webContents.send) ----
ipcMain.handle("research:start", async (_e, args: { query: string; defaultProfileId: string }) => {
  const query = String(args?.query ?? "").trim();
  const defaultProfileId = String(args?.defaultProfileId ?? "");
  if (!query) return { started: false, error: "Query is empty" };
  if (!defaultProfileId) return { started: false, error: "No profile selected" };
  if (!hasProfile(defaultProfileId)) return { started: false, error: "Selected profile no longer exists — pick another in the query bar or Settings" };
  const runId = crypto.randomUUID();
  const ctrl = new AbortController();
  runs.set(runId, ctrl);
  const wc = win?.webContents;
  const emit = (event: ResearchEvent) => {
    wc?.send("research:event", { runId, event });
  };
  // fire-and-forget; completion/error delivered as events
  void (async () => {
    try {
      await runDeepResearch({ query, defaultProfileId, signal: ctrl.signal, emit });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e?.code === "ABORTED" || ctrl.signal.aborted) emit({ kind: "error", message: "Research cancelled." });
      else emit({ kind: "error", message: String(e?.message ?? e).slice(0, 1000) });
    } finally {
      runs.delete(runId);
    }
  })();
  return { started: true, runId };
});

ipcMain.handle("research:cancel", (_e, runId: string) => {
  runs.get(String(runId))?.abort();
  return { ok: true };
});
