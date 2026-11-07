/**
 * 与后端通信的基址。开发时通常留空，由 Vite 代理到 Flask；
 * 独立部署静态资源时设为完整后端地址，例如 http://127.0.0.1:5000
 */
const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
export const API_BASE = raw.replace(/\/$/, '');

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!API_BASE) return p;
  return `${API_BASE}${p}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

export async function readJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T;
  if (!res.ok) throw new Error(`请求失败：${res.status}`);
  return data;
}

export function streamVideoUrl(serverPath: string): string {
  return apiUrl(`/stream-video?path=${encodeURIComponent(serverPath)}&_t=${Date.now()}`);
}

export function downloadFileUrl(filename: string): string {
  return apiUrl(`/download/${encodeURIComponent(filename)}`);
}
