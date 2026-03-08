export type Config = {
  imap: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string; pass: string };
    folder: string;
    processedFolder?: string;
    pollIntervalMs: number;
  };
  webhook?: {
    url: string;
    secret: string;
  };
  output?: {
    directory: string;
  };
};
