declare module "archiver" {
  export class ZipArchive {
    constructor(options?: { zlib?: { level?: number } });

    append(source: Buffer | string, options: { name: string }): this;
    file(source: string, options: { name: string }): this;
    finalize(): Promise<void>;
    once(event: "error", listener: (error: Error) => void): this;
    pipe<T extends NodeJS.WritableStream>(destination: T): T;
  }
}
