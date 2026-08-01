/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端根地址，如 http://127.0.0.1:5000；留空则请求相对路径（配合 Vite 代理或同域部署） */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
