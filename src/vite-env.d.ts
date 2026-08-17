/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module '*.woff2?inline' {
  const dataUri: string;
  export default dataUri;
}
