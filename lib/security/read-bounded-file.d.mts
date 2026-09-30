export type ReadBounds = { minBytes?: number;maxBytes: number };
export type ReadBoundedFileDetails = { bytes: Buffer;mode: number };

export function readBoundedRegularFile(path: string,bounds: ReadBounds): Promise<Buffer>;
export function readBoundedRegularFileDetails(path: string,bounds: ReadBounds): Promise<ReadBoundedFileDetails>;
