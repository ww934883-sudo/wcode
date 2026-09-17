import type { WcodeBridge } from "../shared/protocol";

declare global {
  interface Window {
    /** Electron preload 注入；浏览器预览缺失时由 mock 桥兜底 */
    wcode?: WcodeBridge;
  }
}

export {};

declare module "*.png" {
  const src: string;
  export default src;
}
