import { contextBridge, ipcRenderer } from "electron";

export interface IElectronAPI {
  listProfiles: () => Promise<unknown[]>;
  saveProfile: (input: unknown) => Promise<{ id: string }>;
  deleteProfile: (id: string) => Promise<{ ok: boolean }>;
  testProfile: (id: string) => Promise<{ ok: boolean; info: string }>;
  getSearch: () => Promise<{ provider: string; baseUrlOverride: string; hasKey: boolean }>;
  saveSearch: (input: unknown) => Promise<{ ok: boolean }>;
  startResearch: (args: { query: string; defaultProfileId: string }) => Promise<{ started: boolean; runId?: string; error?: string }>;
  cancelResearch: (runId: string) => Promise<{ ok: boolean }>;
  onResearchEvent: (cb: (evt: { runId: string; event: unknown }) => void) => () => void;
}

// Minimal explicit surface — no raw ipcRenderer passthrough.
const api: IElectronAPI = {
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  saveProfile: (input: unknown) => ipcRenderer.invoke("profiles:save", input),
  deleteProfile: (id: string) => ipcRenderer.invoke("profiles:delete", id),
  testProfile: (id: string) => ipcRenderer.invoke("profiles:test", id),
  getSearch: () => ipcRenderer.invoke("search:get"),
  saveSearch: (input: unknown) => ipcRenderer.invoke("search:save", input),
  startResearch: (args: { query: string; defaultProfileId: string }) => ipcRenderer.invoke("research:start", args),
  cancelResearch: (runId: string) => ipcRenderer.invoke("research:cancel", runId),
  onResearchEvent: (cb) => {
    const listener = (_e: unknown, payload: { runId: string; event: unknown }) => cb(payload);
    ipcRenderer.on("research:event", listener);
    return () => ipcRenderer.removeListener("research:event", listener);
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
