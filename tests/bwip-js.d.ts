// bwip-js ships types behind a Node-only export condition that this project's module resolution does not select.
declare module 'bwip-js' {
  const bwipjs: { toBuffer(options: Record<string, unknown>): Promise<Buffer> };
  export default bwipjs;
}
